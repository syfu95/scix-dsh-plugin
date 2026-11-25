/**
 * `search` — dual-path RRF fusion of two REAL ADS/SciX signals (decision A):
 *   1. Solr lexical relevance: GET search/query, q passed through (natural
 *      language works via Solr default-field search), sort=score desc.
 *   2. Text similarity: q=similar(bibcode:"<top lexical hit>") — the
 *      MoreLikeThis-style second-order operator over abstracts (api-brief
 *      §3). The seed is the top lexical hit because similar() needs an inner
 *      query; this is documented in the output (similar_seed_bibcode).
 * Fused with Reciprocal Rank Fusion, k=60. This is lexical+text-similarity
 * fusion, NOT vector/embedding semantics — no embeddings exist in the public
 * API. Hits are auto-added to the session working set.
 * @module tools/search
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ScixError } from '../core/errors.js'
import { TOOL_NAMES } from '../contracts/tools.js'
import { ERROR_CODES } from '../contracts/errors.js'
import { sessionKeyFromExec } from './session.js'
import { escapeSolrPhrase } from './bibcode.js'
import { SEARCH_FL, mapListPaper, BODY_ESTIMATE_NOTE } from './paper-map.js'
import { rrfFuse, RRF_K } from './rrf.js'

/** Default / maximum result count (bounded output). */
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100
/** Candidate pool per signal: enough ranks for fusion, bounded API rows. */
const MAX_POOL_ROWS = 100

/** doctype filter vocabulary (api-brief §2 filter mapping). */
const DOCTYPES = Object.freeze([
  'abstract', 'article', 'book', 'bookreview', 'catalog', 'circular',
  'editorial', 'eprint', 'erratum', 'inbook', 'inproceedings', 'mastersthesis',
  'misc', 'newsletter', 'obituary', 'phdthesis', 'pressrelease', 'proceedings',
  'proposal', 'software', 'talk', 'techreport',
])

const RANKING_NOTE =
  'Ranking = Reciprocal Rank Fusion (k=60) of two real ADS signals: Solr lexical relevance ' +
  '(score desc) and similar() abstract text-similarity (MoreLikeThis-style) seeded from the top ' +
  'lexical hit. This is lexical+text-similarity fusion, NOT vector/embedding semantics.'

/**
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createSearchTool(deps) {
  return defineTool({
    name: TOOL_NAMES.SEARCH,
    description:
      'Search SciX/NASA ADS literature. Ranks results by fusing Solr lexical relevance with ' +
      'similar() abstract text-similarity (RRF k=60; not vector semantics). Natural-language ' +
      'queries pass through to Solr. Filters: year range, arXiv class, doctype, first author, ' +
      'UAT concept. Hits are auto-added to the session working set (working_set_id returned). ' +
      'All bibcodes are verbatim API values.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language or keyword query (Solr syntax also accepted).' },
      year_min: { type: 'integer', description: 'Inclusive publication-year lower bound.' },
      year_max: { type: 'integer', description: 'Inclusive publication-year upper bound.' },
      arxiv_class: { type: 'string', description: 'arXiv class filter, e.g. astro-ph.EP.' },
      doctype: { type: 'string', description: `ADS document type filter. One of: ${DOCTYPES.join(', ')}.` },
      first_author: { type: 'string', description: 'First-author filter, e.g. "Smith, J".' },
      uat: { type: 'string', description: 'Unified Astronomy Thesaurus concept: term label (e.g. "Exoplanet atmospheres") or numeric UAT id; passed to the ADS uat field.' },
      limit: { type: 'integer', description: `Maximum papers to return, 1..${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          papers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                bibcode: { type: 'string' },
                body_available: { type: 'boolean' },
              },
            },
          },
          total_count: { type: 'integer' },
          returned_count: { type: 'integer' },
          truncated: { type: 'boolean' },
          ranking: { type: 'string' },
          ranking_k: { type: 'integer' },
          ranking_note: { type: 'string' },
          fusion: { type: 'string' },
          similar_seed_bibcode: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          fusion_note: { type: 'string' },
          working_set_id: { type: 'string' },
          added_to_working_set: { type: 'integer' },
          body_available_note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const violations = []
      if (typeof args.query !== 'string' || args.query.trim().length === 0) {
        violations.push('query must be a non-empty string')
      }
      const limit = args.limit ?? DEFAULT_LIMIT
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        violations.push(`limit must be an integer in 1..${MAX_LIMIT}`)
      }
      if (args.year_min !== undefined && args.year_max !== undefined && args.year_min > args.year_max) {
        violations.push('year_min must be <= year_max')
      }
      if (args.doctype !== undefined && !DOCTYPES.includes(args.doctype)) {
        violations.push(`doctype must be one of: ${DOCTYPES.join(', ')}`)
      }
      if (violations.length > 0) throw new ToolArgsError(violations)

      /** @type {string[]} */
      const fq = []
      if (args.year_min !== undefined || args.year_max !== undefined) {
        fq.push(`year:[${args.year_min ?? '*'} TO ${args.year_max ?? '*'}]`)
      }
      if (args.arxiv_class !== undefined) fq.push(`arxiv_class:"${escapeSolrPhrase(args.arxiv_class)}"`)
      if (args.doctype !== undefined) fq.push(`doctype:"${args.doctype}"`)
      if (args.first_author !== undefined) fq.push(`first_author:"${escapeSolrPhrase(args.first_author)}"`)
      if (args.uat !== undefined) {
        fq.push(/^\d+$/.test(args.uat) ? `uat:${args.uat}` : `uat:"${escapeSolrPhrase(args.uat)}"`)
      }
      const poolRows = Math.min(Math.max(limit * 3, 30), MAX_POOL_ROWS)
      /** @type {Record<string, unknown>} */
      const baseParams = { fl: SEARCH_FL, rows: poolRows }
      if (fq.length > 0) baseParams.fq = fq

      // Signal 1: lexical relevance. Errors propagate untouched (TOKEN_MISSING,
      // RATE_LIMITED, QUOTA_EXCEEDED, API_ERROR, ABORTED).
      const lexicalJson = await deps.client.request('/search/query', {
        params: { ...baseParams, q: args.query, sort: 'score desc' },
        signal: exec.signal,
      })
      const lexicalDocs = docsOf(lexicalJson)
      const totalCount = numFoundOf(lexicalJson, lexicalDocs.length)

      // Signal 2: similar() seeded from the top lexical hit (documented).
      /** @type {Record<string, unknown>[]} */
      let similarDocs = []
      let fusion = 'dual-path'
      let fusionNote
      let seedBibcode = null
      const topBibcode = lexicalDocs[0]?.bibcode
      if (typeof topBibcode === 'string' && topBibcode.length > 0) {
        seedBibcode = topBibcode
        try {
          const similarJson = await deps.client.request('/search/query', {
            params: { ...baseParams, q: `similar(bibcode:"${escapeSolrPhrase(topBibcode)}")` },
            signal: exec.signal,
          })
          similarDocs = docsOf(similarJson)
        } catch (error) {
          if (error instanceof ScixError && error.code === ERROR_CODES.ABORTED) throw error
          if (error instanceof ScixError) {
            fusion = 'lexical-only'
            fusionNote = `similar() text-similarity signal unavailable (${error.code}); results use lexical ranking only.`
          } else {
            throw error
          }
        }
      } else {
        fusion = 'lexical-only'
        fusionNote = 'No lexical hits, so similar() has no seed; nothing to fuse.'
      }

      const fused = rrfFuse([
        { name: 'lexical', bibcodes: lexicalDocs.map((d) => d.bibcode).filter((b) => typeof b === 'string') },
        { name: 'similar', bibcodes: similarDocs.map((d) => d.bibcode).filter((b) => typeof b === 'string') },
      ])
      /** @type {Map<string, Record<string, unknown>>} */
      const byBibcode = new Map()
      for (const doc of [...similarDocs, ...lexicalDocs]) {
        if (typeof doc.bibcode === 'string') byBibcode.set(doc.bibcode, doc)
      }
      const papers = []
      for (const entry of fused.slice(0, limit)) {
        const doc = byBibcode.get(entry.bibcode)
        const paper = doc ? mapListPaper(doc) : null
        if (!paper) continue
        paper.rrf_score = Math.round(entry.score * 1e6) / 1e6
        paper.lexical_rank = entry.ranks.lexical ?? null
        paper.similar_rank = entry.ranks.similar ?? null
        papers.push(paper)
      }

      const sessionKey = sessionKeyFromExec(exec)
      const added = deps.workingSets.add(sessionKey, papers)

      return {
        papers,
        total_count: totalCount,
        returned_count: papers.length,
        truncated: totalCount > papers.length,
        ranking: 'rrf-fusion',
        ranking_k: RRF_K,
        ranking_note: RANKING_NOTE,
        fusion,
        similar_seed_bibcode: seedBibcode,
        ...(fusionNote !== undefined ? { fusion_note: fusionNote } : {}),
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
