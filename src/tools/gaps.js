/**
 * find_gaps CLIENT-SIDE heuristics. Dependency-free (plain node).
 *
 * HONESTY: this is a heuristic analysis over API-derived citation/reference
 * links and metadata facets — NOT the private-corpus PageRank / community
 * detection of scix-agent (api-brief §8). Every surfaced direction is backed
 * by verbatim ADS bibcodes. Signals:
 *   1. frequently-linked external papers absent from the set (bridge papers),
 *   2. temporal gaps: years active in the neighborhood but unrepresented in
 *      the set,
 *   3. topic gaps: UAT/keyword terms frequent in neighbors, absent from the
 *      set,
 *   4. author bridges: first authors frequent in neighbors, absent from the
 *      set.
 * @module tools/gaps
 */
import { toYear } from './paper-map.js'

/** Documented bounds for the heuristic (kept small to bound API usage). */
export const GAP_LIMITS = Object.freeze({
  MAX_ANALYZED_MEMBERS: 10,
  MAX_LINKS_PER_MEMBER_DIRECTION: 200,
  MAX_CANDIDATES_FETCHED: 200,
  MAX_CANDIDATES_RETURNED: 20,
  MAX_TEMPORAL_GAPS: 5,
  MAX_TOPIC_GAPS: 10,
  MAX_AUTHOR_GAPS: 5,
  MIN_LINK_COUNT: 2,
  EVIDENCE_PER_GAP: 3,
})

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length > 0) : []
}

/**
 * Count how many distinct set members link to each external bibcode.
 * @param {Record<string, unknown>[]} members Docs with reference/citation arrays.
 * @param {Set<string>} memberBibcodes
 * @param {Set<string>} excludedSet
 * @returns {{ counts: Map<string, { linkedBy: Set<string>, asReferenceOf: Set<string>, asCitationOf: Set<string> }>, linksTruncated: boolean }}
 */
export function countNeighborLinks(members, memberBibcodes, excludedSet) {
  /** @type {Map<string, { linkedBy: Set<string>, asReferenceOf: Set<string>, asCitationOf: Set<string> }>} */
  const counts = new Map()
  let linksTruncated = false
  for (const member of members) {
    const from = member.bibcode
    for (const direction of ['reference', 'citation']) {
      const raw = strings(member[direction])
      if (raw.length > GAP_LIMITS.MAX_LINKS_PER_MEMBER_DIRECTION) linksTruncated = true
      const list = raw.slice(0, GAP_LIMITS.MAX_LINKS_PER_MEMBER_DIRECTION)
      for (const bibcode of list) {
        if (memberBibcodes.has(bibcode) || excludedSet.has(bibcode)) continue
        let entry = counts.get(bibcode)
        if (!entry) {
          entry = { linkedBy: new Set(), asReferenceOf: new Set(), asCitationOf: new Set() }
          counts.set(bibcode, entry)
        }
        entry.linkedBy.add(from)
        if (direction === 'reference') entry.asReferenceOf.add(from)
        else entry.asCitationOf.add(from)
      }
    }
  }
  return { counts, linksTruncated }
}

/**
 * Rank external candidates by (distinct linking members desc, citation_count
 * desc, bibcode asc). Deterministic.
 * @param {Map<string, { linkedBy: Set<string>, asReferenceOf: Set<string>, asCitationOf: Set<string> }>} counts
 * @param {Map<string, Record<string, unknown>>} neighborDocs
 * @param {number} memberCount
 * @returns {Record<string, unknown>[]}
 */
export function rankCandidates(counts, neighborDocs, memberCount) {
  const minLinks = Math.min(GAP_LIMITS.MIN_LINK_COUNT, Math.max(memberCount, 1))
  const entries = [...counts.entries()]
    .map(([bibcode, entry]) => ({ bibcode, entry }))
    .filter(({ entry }) => entry.linkedBy.size >= minLinks)
  entries.sort((a, b) => {
    if (b.entry.linkedBy.size !== a.entry.linkedBy.size) return b.entry.linkedBy.size - a.entry.linkedBy.size
    const ca = Number(neighborDocs.get(a.bibcode)?.citation_count) || 0
    const cb = Number(neighborDocs.get(b.bibcode)?.citation_count) || 0
    if (cb !== ca) return cb - ca
    return a.bibcode < b.bibcode ? -1 : a.bibcode > b.bibcode ? 1 : 0
  })
  return entries.slice(0, GAP_LIMITS.MAX_CANDIDATES_RETURNED).map(({ bibcode, entry }) => {
    const doc = neighborDocs.get(bibcode)
    /** @type {Record<string, unknown>} */
    const candidate = {
      bibcode,
      link_count: entry.linkedBy.size,
      linked_by: [...entry.linkedBy].sort().slice(0, 10),
      as_reference_of_count: entry.asReferenceOf.size,
      as_citation_of_count: entry.asCitationOf.size,
    }
    if (doc) {
      if (Array.isArray(doc.title) && typeof doc.title[0] === 'string') candidate.title = doc.title[0]
      const year = toYear(doc)
      if (year !== undefined) candidate.year = year
      if (typeof doc.citation_count === 'number') candidate.citation_count = doc.citation_count
    }
    return candidate
  })
}

/**
 * Temporal gaps: consecutive year ranges where neighbors are active but the
 * set has no members. Evidence: top-cited neighbor bibcodes in the range.
 * @param {Record<string, unknown>[]} members
 * @param {Record<string, unknown>[]} neighbors
 * @returns {Record<string, unknown>[]}
 */
export function temporalGaps(members, neighbors) {
  const memberYears = new Set(members.map((m) => toYear(m)).filter((y) => y !== undefined))
  /** @type {Map<number, Record<string, unknown>[]>} */
  const byYear = new Map()
  for (const doc of neighbors) {
    const year = toYear(doc)
    if (year === undefined) continue
    const list = byYear.get(year) ?? []
    list.push(doc)
    byYear.set(year, list)
  }
  if (byYear.size === 0) return []
  const threshold = Math.max(3, Math.ceil(neighbors.length * 0.15))
  const gapYears = [...byYear.keys()]
    .filter((year) => !memberYears.has(year) && byYear.get(year).length >= threshold)
    .sort((a, b) => a - b)
  /** @type {number[][]} */
  const ranges = []
  for (const year of gapYears) {
    const last = ranges[ranges.length - 1]
    if (last && year === last[last.length - 1] + 1) last.push(year)
    else ranges.push([year])
  }
  return ranges.slice(0, GAP_LIMITS.MAX_TEMPORAL_GAPS).map((range) => {
    const docs = range.flatMap((year) => byYear.get(year) ?? [])
    docs.sort((a, b) => (Number(b.citation_count) || 0) - (Number(a.citation_count) || 0))
    return {
      year_min: range[0],
      year_max: range[range.length - 1],
      neighbor_count: docs.length,
      evidence: docs.slice(0, GAP_LIMITS.EVIDENCE_PER_GAP).map((d) => d.bibcode),
    }
  })
}

/**
 * Topic gaps: UAT/keyword terms frequent among neighbors but absent from
 * every member's terms (case-insensitive comparison, verbatim display).
 * @param {Record<string, unknown>[]} members
 * @param {Record<string, unknown>[]} neighbors
 * @returns {Record<string, unknown>[]}
 */
export function topicGaps(members, neighbors) {
  const memberTerms = new Set()
  for (const member of members) {
    for (const field of ['uat', 'keyword', 'keyword_norm']) {
      for (const term of strings(member[field])) memberTerms.add(term.toLowerCase())
    }
  }
  /** @type {Map<string, { display: string, source: string, docs: Map<string, Record<string, unknown>> }>} */
  const termCounts = new Map()
  for (const doc of neighbors) {
    for (const [field, source] of [['uat', 'uat'], ['keyword', 'keyword']]) {
      for (const term of strings(doc[field])) {
        const key = term.toLowerCase()
        if (memberTerms.has(key)) continue
        let entry = termCounts.get(key)
        if (!entry) {
          entry = { display: term, source, docs: new Map() }
          termCounts.set(key, entry)
        }
        if (typeof doc.bibcode === 'string') entry.docs.set(doc.bibcode, doc)
      }
    }
  }
  const entries = [...termCounts.values()].filter((entry) => entry.docs.size >= 2)
  entries.sort((a, b) => {
    if (b.docs.size !== a.docs.size) return b.docs.size - a.docs.size
    return a.display < b.display ? -1 : a.display > b.display ? 1 : 0
  })
  return entries.slice(0, GAP_LIMITS.MAX_TOPIC_GAPS).map((entry) => {
    const docs = [...entry.docs.values()]
    docs.sort((a, b) => (Number(b.citation_count) || 0) - (Number(a.citation_count) || 0))
    return {
      term: entry.display,
      source: entry.source,
      neighbor_count: entry.docs.size,
      evidence: docs.slice(0, GAP_LIMITS.EVIDENCE_PER_GAP).map((d) => d.bibcode),
    }
  })
}

/**
 * Author bridges: first authors frequent among neighbors but absent from
 * the set's author lists (case-insensitive exact-name comparison).
 * @param {Record<string, unknown>[]} members
 * @param {Record<string, unknown>[]} neighbors
 * @returns {Record<string, unknown>[]}
 */
export function authorGaps(members, neighbors) {
  const memberAuthors = new Set()
  for (const member of members) {
    for (const author of strings(member.author)) memberAuthors.add(author.toLowerCase())
  }
  /** @type {Map<string, { display: string, docs: Map<string, Record<string, unknown>> }>} */
  const counts = new Map()
  for (const doc of neighbors) {
    const first = typeof doc.first_author === 'string' ? doc.first_author : strings(doc.author)[0]
    if (!first) continue
    const key = first.toLowerCase()
    if (memberAuthors.has(key)) continue
    let entry = counts.get(key)
    if (!entry) {
      entry = { display: first, docs: new Map() }
      counts.set(key, entry)
    }
    if (typeof doc.bibcode === 'string') entry.docs.set(doc.bibcode, doc)
  }
  const entries = [...counts.values()].filter((entry) => entry.docs.size >= 2)
  entries.sort((a, b) => {
    if (b.docs.size !== a.docs.size) return b.docs.size - a.docs.size
    return a.display < b.display ? -1 : a.display > b.display ? 1 : 0
  })
  return entries.slice(0, GAP_LIMITS.MAX_AUTHOR_GAPS).map((entry) => {
    const docs = [...entry.docs.values()]
    docs.sort((a, b) => (Number(b.citation_count) || 0) - (Number(a.citation_count) || 0))
    return {
      author: entry.display,
      neighbor_count: entry.docs.size,
      evidence: docs.slice(0, GAP_LIMITS.EVIDENCE_PER_GAP).map((d) => d.bibcode),
    }
  })
}

/**
 * Full heuristic analysis. `members` carry raw reference/citation arrays
 * (GAP_MEMBER_FL); `neighbors` are metadata docs for the top-frequency
 * external bibcodes; `excluded` bibcodes are filtered everywhere.
 * @param {{ members: Record<string, unknown>[], neighbors: Record<string, unknown>[], excluded?: string[] }} input
 * @returns {Record<string, unknown>}
 */
export function analyzeGaps({ members, neighbors, excluded = [] }) {
  const memberBibcodes = new Set(members.map((m) => m.bibcode))
  const excludedSet = new Set(excluded)
  // Excluded / member bibcodes are filtered from EVERY signal, including the
  // neighbor metadata pool (the tool never fetches them, but the pure
  // function stays consistent when handed a wider pool).
  const cleanNeighbors = neighbors.filter(
    (doc) => typeof doc.bibcode === 'string' && !memberBibcodes.has(doc.bibcode) && !excludedSet.has(doc.bibcode),
  )
  const { counts, linksTruncated } = countNeighborLinks(members, memberBibcodes, excludedSet)
  const neighborDocs = new Map(cleanNeighbors.map((doc) => [doc.bibcode, doc]))
  const candidates = rankCandidates(counts, neighborDocs, members.length)
  return {
    candidates,
    temporal_gaps: temporalGaps(members, cleanNeighbors),
    topic_gaps: topicGaps(members, cleanNeighbors),
    author_gaps: authorGaps(members, cleanNeighbors),
    stats: {
      analyzed_members: members.length,
      external_papers_linked: counts.size,
      neighbors_with_metadata: neighborDocs.size,
      links_truncated: linksTruncated,
    },
  }
}
