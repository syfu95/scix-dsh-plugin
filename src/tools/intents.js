/**
 * Semantic Scholar citation-intent matching. Dependency-free.
 *
 * HONESTY RULES (design decision C, api-brief §6):
 * - The ONLY real intent source is S2's taxonomy: background / method /
 *   result_comparison. support/extend/contrast labels exist in NO API and
 *   are never produced.
 * - Intents are attached VERBATIM from the S2 response with
 *   intent_source:'semantic-scholar'. No match / unavailable / error →
 *   intents:null (null means "no data", never "no intent").
 * - Matching normalizes DOI case and strips URL prefixes / arXiv version
 *   suffixes FOR LOOKUP ONLY; all returned identifiers stay verbatim ADS.
 * @module tools/intents
 */

/** S2 citations endpoint (api-brief §6; fields per lead decision C). */
export const S2_CITATIONS_FIELDS = 'intents,contexts,title,externalIds'
/** One bounded S2 page; unauthenticated shared pool 429s quickly. */
export const S2_CITATIONS_LIMIT = 100

/**
 * Normalize a DOI for matching only: trim, lowercase, strip URL prefix.
 * @param {string} doi
 * @returns {string}
 */
export function normalizeDoi(doi) {
  return doi.trim().toLowerCase().replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
}

/**
 * Normalize an arXiv id for matching only: strip a trailing version suffix.
 * @param {string} id
 * @returns {string}
 */
export function normalizeArxivId(id) {
  return id.trim().replace(/v\d+$/i, '')
}

/**
 * Build the S2 paper key for the TARGET paper from ADS metadata.
 * DOI preferred, then arXiv id (identifier/eid preferred over bibcode).
 * @param {Record<string, unknown>} doc ADS doc with doi/identifier/eid.
 * @param {(doc: Record<string, unknown>) => ({ arxiv_id: string }|null)} resolveArxivId
 * @returns {string|null} e.g. 'DOI:10.1051/…' or 'ARXIV:2103.01234'.
 */
export function s2PaperKey(doc, resolveArxivId) {
  const dois = Array.isArray(doc.doi) ? doc.doi.filter((d) => typeof d === 'string' && d.length > 0) : []
  if (dois.length > 0) return `DOI:${dois[0]}`
  const resolved = resolveArxivId(doc)
  if (resolved) return `ARXIV:${resolved.arxiv_id}`
  return null
}

/**
 * Index one S2 citations page by normalized DOI / arXiv id of citing papers.
 * @param {unknown} s2json Parsed S2 response ({ data: [...] }).
 * @returns {Map<string, { intents: string[], contexts: string[], isInfluential?: boolean }>}
 */
export function buildS2Index(s2json) {
  /** @type {Map<string, { intents: string[], contexts: string[], isInfluential?: boolean }>} */
  const index = new Map()
  const data = s2json && typeof s2json === 'object' && Array.isArray(s2json.data) ? s2json.data : []
  for (const entry of data) {
    const citing = entry?.citingPaper
    if (!citing || typeof citing !== 'object') continue
    const intents = Array.isArray(entry.intents) ? entry.intents.filter((i) => typeof i === 'string') : []
    const contexts = Array.isArray(entry.contexts) ? entry.contexts.filter((c) => typeof c === 'string') : []
    const record = { intents, contexts }
    if (typeof entry.isInfluential === 'boolean') record.isInfluential = entry.isInfluential
    const ext = citing.externalIds && typeof citing.externalIds === 'object' ? citing.externalIds : {}
    if (typeof ext.DOI === 'string' && ext.DOI.length > 0) {
      index.set(`doi:${normalizeDoi(ext.DOI)}`, record)
    }
    if (typeof ext.ArXiv === 'string' && ext.ArXiv.length > 0) {
      index.set(`arxiv:${normalizeArxivId(ext.ArXiv)}`, record)
    }
  }
  return index
}

/**
 * Look up one ADS citing doc in the S2 index (DOI first, then arXiv id).
 * @param {Record<string, unknown>} doc
 * @param {Map<string, { intents: string[], contexts: string[], isInfluential?: boolean }>} index
 * @param {(doc: Record<string, unknown>) => ({ arxiv_id: string }|null)} resolveArxivId
 * @returns {{ intents: string[], contexts: string[], isInfluential?: boolean }|null}
 */
export function matchS2Intents(doc, index, resolveArxivId) {
  const dois = Array.isArray(doc.doi) ? doc.doi.filter((d) => typeof d === 'string' && d.length > 0) : []
  for (const doi of dois) {
    const hit = index.get(`doi:${normalizeDoi(doi)}`)
    if (hit) return hit
  }
  const resolved = resolveArxivId(doc)
  if (resolved) {
    const hit = index.get(`arxiv:${normalizeArxivId(resolved.arxiv_id)}`)
    if (hit) return hit
  }
  return null
}
