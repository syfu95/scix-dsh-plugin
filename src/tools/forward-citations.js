/**
 * `forward_citations` — ADS citations() list + best-effort Semantic Scholar
 * intent enrichment (design decision C; api-brief §6).
 *
 * HONESTY: ADS/SciX has NO citation-intent field. The only real API intent
 * source is S2 (taxonomy: background / method / result_comparison), attached
 * VERBATIM with intent_source:'semantic-scholar'. support/extend/contrast
 * labels exist in no API and are NEVER generated. Unavailable / 429 / error /
 * no match → intents:null + an explicit note (null = no data, not "no
 * intent"). S2 is external: requestExternal, no auth header, own rate lane.
 * @module tools/forward-citations
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ScixError } from '../core/errors.js'
import { TOOL_NAMES } from '../contracts/tools.js'
import { ERROR_CODES } from '../contracts/errors.js'
import { sessionKeyFromExec } from './session.js'
import { isBibcode, escapeSolrPhrase } from './bibcode.js'
import { FORWARD_FL, mapListPaper, resolveArxivId, BODY_ESTIMATE_NOTE } from './paper-map.js'
import { s2PaperKey, buildS2Index, matchS2Intents, S2_CITATIONS_FIELDS, S2_CITATIONS_LIMIT } from './intents.js'

/** ADS citing-paper page cap (bounded output; numFound drives truncated). */
export const FORWARD_ROWS = 100
/** Context bounds: first 2 contexts, each ≤500 chars, truncation flagged. */
const MAX_CONTEXTS = 2
const MAX_CONTEXT_CHARS = 500

const BASE_INTENT_NOTE =
  "Intents are Semantic Scholar's real taxonomy (background/method/result_comparison), attached " +
  "verbatim with intent_source:'semantic-scholar'. support/extend/contrast labels exist in no API " +
  'and are never generated. intents:null means no S2 data for that citing paper (not "no intent"); ' +
  'intents:[] means S2 matched the paper but classified no intents. S2 coverage is limited to its ' +
  'fulltext holdings and one bounded page (100 citing papers).'

/**
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createForwardCitationsTool(deps) {
  return defineTool({
    name: TOOL_NAMES.FORWARD_CITATIONS,
    description:
      'List papers citing a given bibcode (ADS citations(), ≤100 returned, sorted by citation ' +
      'count) with best-effort Semantic Scholar citation intents (background/method/' +
      'result_comparison) matched by DOI/arXiv id. intents:null means no S2 data — labels are ' +
      'never fabricated. Results join the session working set.',
    parameters: {
      bibcode: { type: 'string', required: true, description: 'Verbatim ADS bibcode of the cited paper.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bibcode: { type: 'string' },
          citations: { type: 'array', items: { type: 'object', additionalProperties: true } },
          total_count: { type: 'integer' },
          returned_count: { type: 'integer' },
          truncated: { type: 'boolean' },
          intent_coverage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              returned: { type: 'integer' },
              matched: { type: 'integer' },
              with_intents: { type: 'integer' },
            },
          },
          s2_paper_key: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          note: { type: 'string' },
          working_set_id: { type: 'string' },
          added_to_working_set: { type: 'integer' },
          body_available_note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!isBibcode(args.bibcode)) {
        throw new ToolArgsError(['bibcode must be a verbatim ADS bibcode token (letters/digits/.&:_-, no spaces or quotes)'])
      }
      const seedQ = `bibcode:"${escapeSolrPhrase(args.bibcode)}"`
      // Target metadata for the S2 key (DOI preferred, then arXiv id).
      const seedJson = await deps.client.request('/search/query', {
        params: { q: seedQ, rows: 1, fl: 'bibcode,doi,identifier,eid' },
        signal: exec.signal,
      })
      const seedDoc = seedJson?.response?.docs?.[0]
      if (!seedDoc || typeof seedDoc.bibcode !== 'string') {
        throw new ScixError(
          ERROR_CODES.API_ERROR,
          `No ADS record found for bibcode "${args.bibcode}". Use a bibcode verbatim from search results.`,
          { status: 404 },
        )
      }
      const citJson = await deps.client.request('/search/query', {
        params: { q: `citations(${seedQ})`, fl: FORWARD_FL, rows: FORWARD_ROWS, sort: 'citation_count desc' },
        signal: exec.signal,
      })
      const docs = docsOf(citJson)
      const totalCount = numFoundOf(citJson, docs.length)

      // Best-effort S2 enrichment; every failure degrades honestly.
      const s2Key = s2PaperKey(seedDoc, resolveArxivId)
      /** @type {Map<string, { intents: string[], contexts: string[], isInfluential?: boolean }>|null} */
      let s2Index = null
      let degradation = null
      if (!s2Key) {
        degradation = 'Target has no DOI or arXiv id in ADS metadata; Semantic Scholar matching skipped.'
      } else {
        const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(s2Key)}/citations` +
          `?fields=${S2_CITATIONS_FIELDS}&limit=${S2_CITATIONS_LIMIT}`
        try {
          const response = await deps.client.requestExternal(url, { signal: exec.signal, accept: 'application/json' })
          if (response?.status === 200 && typeof response.text === 'string') {
            try {
              s2Index = buildS2Index(JSON.parse(response.text))
            } catch {
              degradation = 'Semantic Scholar returned invalid JSON; intents unavailable.'
            }
          } else {
            degradation = `Semantic Scholar citations returned HTTP ${response?.status ?? 'no response'}; intents unavailable.`
          }
        } catch (error) {
          if (error instanceof ScixError && error.code === ERROR_CODES.ABORTED) throw error
          if (error instanceof ScixError) {
            degradation = `Semantic Scholar request failed (${error.code}); intents unavailable.`
          } else {
            throw error
          }
        }
      }

      let matched = 0
      let withIntents = 0
      const citations = []
      for (const doc of docs) {
        const paper = mapListPaper(doc)
        if (!paper) continue
        if (Array.isArray(doc.doi)) {
          const dois = doc.doi.filter((d) => typeof d === 'string')
          if (dois.length > 0) paper.doi = dois
        }
        const hit = s2Index ? matchS2Intents(doc, s2Index, resolveArxivId) : null
        if (hit) {
          matched += 1
          paper.intents = [...hit.intents]
          paper.intent_source = 'semantic-scholar'
          if (hit.intents.length > 0) withIntents += 1
          if (hit.contexts.length > 0) {
            const capped = hit.contexts.slice(0, MAX_CONTEXTS).map((c) => c.slice(0, MAX_CONTEXT_CHARS))
            paper.intent_contexts = capped
            paper.contexts_truncated =
              hit.contexts.length > MAX_CONTEXTS || hit.contexts.some((c) => c.length > MAX_CONTEXT_CHARS)
          }
          if (typeof hit.isInfluential === 'boolean') paper.is_influential = hit.isInfluential
        } else {
          paper.intents = null
          paper.intent_source = null
        }
        citations.push(paper)
      }

      const added = deps.workingSets.add(sessionKeyFromExec(exec), citations)
      return {
        bibcode: args.bibcode,
        citations,
        total_count: totalCount,
        returned_count: citations.length,
        truncated: totalCount > citations.length,
        intent_coverage: { returned: citations.length, matched, with_intents: withIntents },
        s2_paper_key: s2Key,
        note: degradation ? `${BASE_INTENT_NOTE} DEGRADED: ${degradation}` : BASE_INTENT_NOTE,
        working_set_id: added.working_set_id,
        added_to_working_set: added.added.length,
        body_available_note: BODY_ESTIMATE_NOTE,
      }
    },
  })
}

/** @param {unknown} json @returns {Record<string, unknown>[]} */
function docsOf(json) {
  const docs = json?.response?.docs
  return Array.isArray(docs) ? docs.filter((d) => d && typeof d === 'object') : []
}

/** @param {unknown} json @param {number} fallback @returns {number} */
function numFoundOf(json, fallback) {
  const n = json?.response?.numFound
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}
