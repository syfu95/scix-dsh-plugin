/**
 * Reciprocal Rank Fusion (RRF) over two REAL ADS/SciX signals:
 *   1. Solr lexical relevance (`search/query`, score desc),
 *   2. `similar(bibcode:"<seed>")` text similarity (MoreLikeThis-style over
 *      abstracts; api-brief §3). This is NOT vector/embedding semantics —
 *      no embeddings exist in the public API.
 *
 * score(d) = Σ_i 1 / (k + rank_i(d)), k = 60 (scix-agent's RRF_K), ranks
 * 1-based; a document absent from a ranking contributes nothing for it.
 * Deterministic ordering: score desc, then lexical rank asc (absent last),
 * then bibcode asc. Dependency-free.
 * @module tools/rrf
 */

/** RRF constant (api-brief §3: scix-agent RRF_K=60). */
export const RRF_K = 60

/**
 * @typedef {Object} Ranking
 * @property {string} name Signal name (e.g. 'lexical', 'similar').
 * @property {string[]} bibcodes Verbatim bibcodes in rank order (best first).
 */

/**
 * Fuse rankings by bibcode.
 * @param {Ranking[]} rankings
 * @param {number} [k=RRF_K]
 * @returns {{ bibcode: string, score: number, ranks: Record<string, number|null> }[]}
 *   Sorted fused results; `ranks` carries each signal's 1-based rank or null.
 */
export function rrfFuse(rankings, k = RRF_K) {
  /** @type {Map<string, { score: number, ranks: Record<string, number|null> }>} */
  const fused = new Map()
  for (const ranking of rankings) {
    const seen = new Set()
    ranking.bibcodes.forEach((bibcode, index) => {
      if (typeof bibcode !== 'string' || bibcode.length === 0 || seen.has(bibcode)) return
      seen.add(bibcode)
      let entry = fused.get(bibcode)
      if (!entry) {
        entry = { score: 0, ranks: {} }
        fused.set(bibcode, entry)
      }
      const rank = index + 1
      entry.score += 1 / (k + rank)
      entry.ranks[ranking.name] = rank
    })
  }
  const names = rankings.map((r) => r.name)
  const results = [...fused.entries()].map(([bibcode, entry]) => {
    /** @type {Record<string, number|null>} */
    const ranks = {}
    for (const name of names) ranks[name] = entry.ranks[name] ?? null
    return { bibcode, score: entry.score, ranks }
  })
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const la = a.ranks.lexical ?? Number.POSITIVE_INFINITY
    const lb = b.ranks.lexical ?? Number.POSITIVE_INFINITY
    if (la !== lb) return la - lb
    return a.bibcode < b.bibcode ? -1 : a.bibcode > b.bibcode ? 1 : 0
  })
  return results
}
