/**
 * `find_gaps` — CLIENT-SIDE heuristic gap analysis over a session working
 * set (design decision per api-brief §8). NOT an API endpoint, and NOT the
 * private-corpus PageRank/community detection of scix-agent.
 *
 * Method: fetch members' raw reference/citation lists + metadata facets
 * (year/UAT/keyword/author) in batched bibcode OR queries; count frequently
 * linked EXTERNAL papers absent from the set; fetch their metadata; surface
 * (1) bridge-paper candidates, (2) temporal gaps, (3) UAT/keyword topic gaps,
 * (4) author bridges. Every direction is backed by verbatim API bibcodes.
 * Bounds: ≤10 members analyzed, ≤200 candidates fetched, ≤9 API requests.
 * @module tools/find-gaps
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ScixError } from '../core/errors.js'
import { TOOL_NAMES } from '../contracts/tools.js'
import { ERROR_CODES } from '../contracts/errors.js'
import { sessionKeyFromExec } from './session.js'
import { bibcodeOrQuery, chunk, BIBCODE_BATCH_SIZE } from './bibcode.js'
import { GAP_MEMBER_FL, GAP_NEIGHBOR_FL } from './paper-map.js'
import { analyzeGaps, countNeighborLinks, GAP_LIMITS } from './gaps.js'

const METHOD_NOTE =
  'Heuristic analysis over API-derived citation/reference links and metadata facets ' +
  '(year/UAT/keyword/author). This is NOT PageRank or community detection over a private corpus ' +
  '(scix-agent); it is a client-side heuristic. Every candidate and evidence bibcode comes ' +
  'verbatim from ADS API responses. Excluded papers are filtered from all signals.'

/**
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createFindGapsTool(deps) {
  return defineTool({
    name: TOOL_NAMES.FIND_GAPS,
    description:
      'Analyze a session working set for research gaps: frequently-linked external papers absent ' +
      'from the set, under-represented year ranges, UAT/keyword topics, and author bridges. ' +
      'Client-side heuristic over real ADS citation links and facets (not PageRank); every ' +
      'direction cites verbatim bibcodes. working_set_id comes from search/traverse results ' +
      '(the session default set is ws-default).',
    parameters: {
      working_set_id: { type: 'string', required: true, description: 'Opaque working-set id from search/traverse results (ws- prefix); ws-default is the session default set.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          working_set_id: { type: 'string' },
          method: { type: 'string' },
          set_size: { type: 'integer' },
          analyzed_members: { type: 'integer' },
          members_truncated: { type: 'boolean' },
          candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
          temporal_gaps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          topic_gaps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          author_gaps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          stats: { type: 'object', additionalProperties: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (typeof args.working_set_id !== 'string' || args.working_set_id.length === 0) {
        throw new ToolArgsError(['working_set_id must be a non-empty string'])
      }
      const sessionKey = sessionKeyFromExec(exec)
      const set = deps.workingSets.get(sessionKey, args.working_set_id)
      if (!set) {
        throw new ScixError(
          ERROR_CODES.API_ERROR,
          `Unknown working_set_id "${args.working_set_id}" in this session. Run search first ` +
            '(hits auto-create the session default set "ws-default") or pass a working_set_id ' +
            'returned by a previous tool call.',
        )
      }
      if (set.size === 0) {
        return {
          working_set_id: set.working_set_id,
          method: 'client-side-heuristic',
          set_size: 0,
          analyzed_members: 0,
          candidates: [],
          temporal_gaps: [],
          topic_gaps: [],
          author_gaps: [],
          stats: { analyzed_members: 0, external_papers_linked: 0, neighbors_with_metadata: 0, links_truncated: false },
          note: `${METHOD_NOTE} The working set is empty — nothing to analyze. Add papers via search/get_paper/citation_traverse.`,
        }
      }

      const membersTruncated = set.papers.length > GAP_LIMITS.MAX_ANALYZED_MEMBERS
      const memberRefs = set.papers.slice(0, GAP_LIMITS.MAX_ANALYZED_MEMBERS)
      const memberBibcodes = memberRefs.map((p) => p.bibcode)
      const memberJson = await deps.client.request('/search/query', {
        params: { q: bibcodeOrQuery(memberBibcodes), fl: GAP_MEMBER_FL, rows: memberBibcodes.length },
        signal: exec.signal,
      })
      const memberDocs = docsOf(memberJson)

      // Rank external neighbors by how many distinct members link to them;
      // fetch metadata for the top-frequency pool only (bounded requests).
      const excludedSet = new Set(set.excluded)
      const { counts } = countNeighborLinks(memberDocs, new Set(memberBibcodes), excludedSet)
      const rankedExternal = [...counts.entries()]
        .sort((a, b) => {
          if (b[1].linkedBy.size !== a[1].linkedBy.size) return b[1].linkedBy.size - a[1].linkedBy.size
          return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
        })
        .slice(0, GAP_LIMITS.MAX_CANDIDATES_FETCHED)
        .map(([bibcode]) => bibcode)
      /** @type {Record<string, unknown>[]} */
      const neighbors = []
      for (const batch of chunk(rankedExternal, BIBCODE_BATCH_SIZE)) {
        const json = await deps.client.request('/search/query', {
          params: { q: bibcodeOrQuery(batch), fl: GAP_NEIGHBOR_FL, rows: batch.length },
          signal: exec.signal,
        })
        neighbors.push(...docsOf(json))
      }

      const analysis = analyzeGaps({ members: memberDocs, neighbors, excluded: set.excluded })
      return {
        working_set_id: set.working_set_id,
        method: 'client-side-heuristic',
        set_size: set.size,
        analyzed_members: memberDocs.length,
        ...(membersTruncated ? { members_truncated: true } : {}),
        candidates: analysis.candidates,
        temporal_gaps: analysis.temporal_gaps,
        topic_gaps: analysis.topic_gaps,
        author_gaps: analysis.author_gaps,
        stats: analysis.stats,
        note: METHOD_NOTE +
          (membersTruncated ? ` Only the first ${GAP_LIMITS.MAX_ANALYZED_MEMBERS} members were analyzed.` : ''),
      }
    },
  })
}

/** @param {unknown} json @returns {Record<string, unknown>[]} */
function docsOf(json) {
  const docs = json?.response?.docs
  return Array.isArray(docs) ? docs.filter((d) => d && typeof d === 'object') : []
}
