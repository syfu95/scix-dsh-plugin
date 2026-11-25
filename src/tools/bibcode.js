/**
 * Bibcode / id hygiene + Solr query batching. Dependency-free (plain node).
 * Identifiers are NEVER rewritten: escaping only protects the Solr phrase
 * syntax; the stored/returned bibcode stays byte-for-byte the API value.
 * @module tools/bibcode
 */

/** Bibcodes per `bibcode:("A" OR "B" …)` metadata batch (keeps URLs bounded). */
export const BIBCODE_BATCH_SIZE = 50
/** Upper bound for one export / library document batch (scix-mcp cap, api-brief §7/§9). */
export const MAX_DOCUMENT_BATCH = 2000

/**
 * Conservative bibcode shape check for model-supplied values. ADS bibcodes
 * are 19 chars, but we accept any bounded printable token without Solr/URL
 * breakers rather than over-rejecting valid variants.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isBibcode(value) {
  return typeof value === 'string'
    && value.length > 0 && value.length <= 64
    && /^[0-9A-Za-z.&:_-]+$/.test(value)
}

/**
 * Library ids are URL-safe base64 `[A-Za-z0-9_-]{1,64}` (api-brief §7).
 * Rejects path injection (`/ \ ? #`, dot segments) before URL construction.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidLibraryId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

/**
 * Escape a value for inclusion in a Solr double-quoted phrase.
 * @param {string} value
 * @returns {string}
 */
export function escapeSolrPhrase(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build a batched metadata query: `bibcode:("A" OR "B" …)`.
 * @param {string[]} bibcodes Verbatim bibcodes (already validated).
 * @returns {string}
 */
export function bibcodeOrQuery(bibcodes) {
  return `bibcode:(${bibcodes.map((b) => `"${escapeSolrPhrase(b)}"`).join(' OR ')})`
}

/**
 * Split an array into fixed-size chunks (last chunk may be shorter).
 * @template T
 * @param {T[]} items
 * @param {number} size Positive integer.
 * @returns {T[][]}
 */
export function chunk(items, size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error('chunk size must be a positive integer')
  const out = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
