/**
 * `citation_traverse` — citation-network traversal (api-brief §2):
 * - backward: q=references(bibcode:"X") — papers X references (foundations).
 * - forward:  q=citations(bibcode:"X")  — papers citing X (follow-ups).
 * - mode 'graph' (default): ONE hop, operator query returns related papers'
 *   metadata directly (rows capped at 100, truncation flagged vs numFound).
 * - mode 'chain': bounded multi-hop walk, FIXED MAX DEPTH 2 (documented):
 *   hop 1 uses the seed's raw reference/citation bibcode list (complete,
 *   capped at 200) with metadata batched via bibcode OR queries (50/query);
 *   hop 2 expands the top-5 hop-1 papers by citation_count the same way
 *   (≤200 new nodes). ≤10 API requests total.
 * Relation labels use the verbatim API field names: 'reference' / 'citation'.
 * Returned papers are added to the session working set.
 * @module tools/citation-traverse
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ScixError } from '../core/errors.js'
import { TOOL_NAMES } from '../contracts/tools.js'
import { ERROR_CODES } from '../contracts/errors.js'
import { sessionKeyFromExec } from './session.js'
import { isBibcode, escapeSolrPhrase, bibcodeOrQuery, chunk, BIBCODE_BATCH_SIZE } from './bibcode.js'
import { TRAVERSE_FL, LINKS_FL, mapListPaper, mapPaperRef, BODY_ESTIMATE_NOTE } from './paper-map.js'

/** One-hop graph result cap (rows); numFound drives the truncated flag. */
export const GRAPH_ROWS = 100
/** Chain bounds (documented in expansion_note). */
export const CHAIN_MAX_DEPTH = 2
export const CHAIN_MAX_NODES_PER_HOP = 200
export const CHAIN_HOP2_SEEDS = 5

const SEED_LINKS_FL = `${LINKS_FL},title,author,year,citation_count`

/**
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createCitationTraverseTool(deps) {
  return defineTool({
    name: TOOL_NAMES.CITATION_TRAVERSE,
    description:
      "Traverse a paper's citation network. direction 'backward' returns its references " +
      '(foundational work); \'forward\' returns citing papers (follow-up work). mode \'graph\' ' +
      '(default) returns a one-hop network (≤100 papers); mode \'chain\' walks a bounded ' +
      'multi-hop chain (fixed max depth 2, top-5 expansion). Relation labels are the verbatim ' +
      'API field names (reference/citation). Results join the session working set.',
    parameters: {
      bibcode: { type: 'string', required: true, description: 'Verbatim ADS bibcode of the starting paper.' },
      direction: { type: 'string', required: true, description: "Traversal direction: 'backward' (references of the seed) or 'forward' (papers citing the seed)." },
      mode: { type: 'string', description: "'graph' (one-hop network, default) or 'chain' (bounded multi-hop walk, max depth 2)." },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bibcode: { type: 'string' },
          direction: { type: 'string', enum: ['backward', 'forward'] },
          mode: { type: 'string', enum: ['graph', 'chain'] },
          papers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          edges: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                citing: { type: 'string' },
                cited: { type: 'string' },
              },
            },
          },
          max_depth: { type: 'integer' },
          expansion_note: { type: 'string' },
          total_count: { type: 'integer' },
          returned_count: { type: 'integer' },
          truncated: { type: 'boolean' },
          working_set_id: { type: 'string' },
          added_to_working_set: { type: 'integer' },
          body_available_note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const violations = []
      if (!isBibcode(args.bibcode)) violations.push('bibcode must be a verbatim ADS bibcode token')
      if (args.direction !== 'backward' && args.direction !== 'forward') {
        violations.push("direction must be 'backward' or 'forward'")
      }
      const mode = args.mode ?? 'graph'
      if (mode !== 'graph' && mode !== 'chain') violations.push("mode must be 'graph' or 'chain'")
      if (violations.length > 0) throw new ToolArgsError(violations)

      const sessionKey = sessionKeyFromExec(exec)
      const relation = args.direction === 'backward' ? 'reference' : 'citation'
      const seedQ = `bibcode:"${escapeSolrPhrase(args.bibcode)}"`

      if (mode === 'graph') {
        const operator = args.direction === 'backward' ? 'references' : 'citations'
        const json = await deps.client.request('/search/query', {
          params: { q: `${operator}(${seedQ})`, fl: TRAVERSE_FL, rows: GRAPH_ROWS, sort: 'citation_count desc' },
          signal: exec.signal,
        })
        const docs = docsOf(json)
        const totalCount = numFoundOf(json, docs.length)
        const papers = docs.map((doc) => {
          const paper = mapListPaper(doc)
          if (!paper) return null
          paper.relation = relation
          return paper
        }).filter(Boolean)
        const added = deps.workingSets.add(sessionKey, papers)
        return {
          bibcode: args.bibcode,
          direction: args.direction,
          mode: 'graph',
          papers,
          total_count: totalCount,
          returned_count: papers.length,
          truncated: totalCount > papers.length,
          working_set_id: added.working_set_id,
          added_to_working_set: added.added.length,
          body_available_note: BODY_ESTIMATE_NOTE,
        }
      }

      // ---- chain mode: bounded BFS, fixed max depth 2 ----
      const seedJson = await deps.client.request('/search/query', {
        params: { q: seedQ, rows: 1, fl: SEED_LINKS_FL },
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
      /** @type {Map<string, Record<string, unknown>>} */
      const nodes = new Map()
      const seedNode = mapListPaper(seedDoc) ?? { bibcode: seedDoc.bibcode }
      seedNode.depth = 0
      seedNode.relation = null
      nodes.set(seedDoc.bibcode, seedNode)
      /** @type {Map<string, true>} */
      const edges = new Map()
      let truncated = false

      const addEdge = (citing, cited) => {
        if (typeof citing === 'string' && typeof cited === 'string') edges.set(`${citing}|${cited}`, true)
      }

      // Hop 1: raw link list → batched metadata.
      const rawList = stringList(seedDoc[args.direction === 'backward' ? 'reference' : 'citation'])
      if (rawList.length > CHAIN_MAX_NODES_PER_HOP) truncated = true
      const hop1Bibcodes = rawList.slice(0, CHAIN_MAX_NODES_PER_HOP)
      const hop1Docs = await fetchMetadata(deps, hop1Bibcodes, exec.signal)
      for (const doc of hop1Docs) {
        const node = mapListPaper(doc)
        if (!node || nodes.has(node.bibcode)) continue
        node.depth = 1
        node.relation = relation
        nodes.set(node.bibcode, node)
        if (args.direction === 'backward') addEdge(seedDoc.bibcode, node.bibcode)
        else addEdge(node.bibcode, seedDoc.bibcode)
      }

      // Hop 2: top-5 hop-1 papers by citation_count (bibcode asc tiebreak).
      const hop1Ranked = hop1Docs
        .filter((doc) => typeof doc.bibcode === 'string')
        .sort((a, b) => {
          const ca = typeof a.citation_count === 'number' ? a.citation_count : 0
          const cb = typeof b.citation_count === 'number' ? b.citation_count : 0
          if (cb !== ca) return cb - ca
          return a.bibcode < b.bibcode ? -1 : a.bibcode > b.bibcode ? 1 : 0
        })
      const hop2Seeds = hop1Ranked.slice(0, CHAIN_HOP2_SEEDS)
      if (hop2Seeds.length > 0) {
        const hop2RawJson = await deps.client.request('/search/query', {
          params: { q: bibcodeOrQuery(hop2Seeds.map((d) => d.bibcode)), rows: hop2Seeds.length, fl: LINKS_FL },
          signal: exec.signal,
        })
        const seen = new Set(nodes.keys())
        /** @type {string[]} */
        const hop2Bibcodes = []
        /** @type {Map<string, string[]>} */
        const linksBySeed = new Map()
        for (const doc of docsOf(hop2RawJson)) {
          const list = stringList(doc[args.direction === 'backward' ? 'reference' : 'citation'])
          linksBySeed.set(doc.bibcode, list)
          for (const bibcode of list) {
            if (seen.has(bibcode)) continue
            seen.add(bibcode)
            hop2Bibcodes.push(bibcode)
          }
        }
        if (hop2Bibcodes.length > CHAIN_MAX_NODES_PER_HOP) truncated = true
        const hop2Capped = hop2Bibcodes.slice(0, CHAIN_MAX_NODES_PER_HOP)
        const hop2Docs = await fetchMetadata(deps, hop2Capped, exec.signal)
        const hop2Set = new Set(hop2Docs.map((d) => d.bibcode))
        for (const doc of hop2Docs) {
          const node = mapListPaper(doc)
          if (!node || nodes.has(node.bibcode)) continue
          node.depth = 2
          node.relation = relation
          nodes.set(node.bibcode, node)
        }
        for (const [hop1Bibcode, list] of linksBySeed) {
          for (const bibcode of list) {
            if (!hop2Set.has(bibcode)) continue
            if (args.direction === 'backward') addEdge(hop1Bibcode, bibcode)
            else addEdge(bibcode, hop1Bibcode)
          }
        }
      }

      const nodeList = [...nodes.values()]
      const edgeList = [...edges.keys()].map((key) => {
        const [citing, cited] = key.split('|')
        return { citing, cited }
      })
      const added = deps.workingSets.add(sessionKey, nodeList.filter((n) => n.depth > 0).map((n) => mapPaperRef(n)))
      return {
        bibcode: args.bibcode,
        direction: args.direction,
        mode: 'chain',
        max_depth: CHAIN_MAX_DEPTH,
        nodes: nodeList,
        edges: edgeList,
        expansion_note:
          `Bounded chain walk, fixed max depth ${CHAIN_MAX_DEPTH}. Hop 1: up to ${CHAIN_MAX_NODES_PER_HOP} ` +
          `bibcodes from the seed's raw ${args.direction === 'backward' ? 'reference' : 'citation'} list, ` +
          `metadata batched ${BIBCODE_BATCH_SIZE} per bibcode OR query. Hop 2: top ${CHAIN_HOP2_SEEDS} hop-1 ` +
          `papers by citation_count expanded the same way (≤${CHAIN_MAX_NODES_PER_HOP} new nodes). ≤10 API requests.`,
        returned_count: nodeList.length,
        truncated,
        working_set_id: added.working_set_id,
        added_to_working_set: added.added.length,
        body_available_note: BODY_ESTIMATE_NOTE,
      }
    },
  })
}

/**
 * Batched metadata fetch via bibcode OR queries (≤50 bibcodes per request).
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @param {string[]} bibcodes
 * @param {AbortSignal} signal
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function fetchMetadata(deps, bibcodes, signal) {
  /** @type {Record<string, unknown>[]} */
  const docs = []
  for (const batch of chunk(bibcodes, BIBCODE_BATCH_SIZE)) {
    if (batch.length === 0) continue
    const json = await deps.client.request('/search/query', {
      params: { q: bibcodeOrQuery(batch), fl: TRAVERSE_FL, rows: batch.length },
      signal,
    })
    docs.push(...docsOf(json))
  }
  return docs
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

/** @param {unknown} value @returns {string[]} */
function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : []
}
