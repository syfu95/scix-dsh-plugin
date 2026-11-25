/**
 * Session-scoped working-set store. Contract: src/contracts/working-set.js.
 * In-memory only; lives for the plugin instance; dispose() clears everything
 * on unload. Dependency-free apart from the contracts constants.
 *
 * Implementation notes (documented choices within the contract):
 * - sessionKey comes from callers (tools derive exec.agent.id — see
 *   src/tools/session.js); sets never leak across sessionKeys.
 * - add() skips bibcodes that are currently EXCLUDED in the target set:
 *   exclusions are sticky user intent until set() replaces membership.
 * - exclude() moves current members into the excluded list (they stay known
 *   but do not count toward size and are filtered from analysis).
 * - set()/exclude() with an explicit new workingSetId create that set;
 *   add()/exclude() without an id auto-create the session default set.
 * - get()/list() return defensive copies; callers cannot mutate store state.
 * @module tools/working-set
 */
import { DEFAULT_WORKING_SET_ID } from '../contracts/working-set.js'

/**
 * @typedef {Object} StoredSet
 * @property {{ bibcode: string, title?: string, author?: string[], year?: number }[]} papers
 * @property {string[]} excluded
 */

/**
 * Create the in-memory store for this plugin instance.
 * @returns {import('../contracts/working-set.js').WorkingSetStore}
 */
export function createWorkingSetStore() {
  /** @type {Map<string, Map<string, StoredSet>>} */
  const sessions = new Map()

  /** @param {string} sessionKey */
  function sessionSets(sessionKey) {
    assertKey(sessionKey)
    let sets = sessions.get(sessionKey)
    if (!sets) {
      sets = new Map()
      sessions.set(sessionKey, sets)
    }
    return sets
  }

  /**
   * @param {string} sessionKey
   * @param {string|undefined} workingSetId
   * @param {boolean} create
   * @returns {{ id: string, set: StoredSet }|undefined}
   */
  function resolve(sessionKey, workingSetId, create) {
    const id = workingSetId === undefined ? DEFAULT_WORKING_SET_ID : workingSetId
    if (typeof id !== 'string' || id.length === 0) throw new Error('workingSetId must be a non-empty string')
    const sets = sessionSets(sessionKey)
    let set = sets.get(id)
    if (!set && create) {
      set = { papers: [], excluded: [] }
      sets.set(id, set)
    }
    return set ? { id, set } : undefined
  }

  /** Sanitize + copy incoming PaperRef-like entries; drop invalid ones. */
  function cleanPapers(papers) {
    if (!Array.isArray(papers)) throw new Error('papers must be an array of PaperRef')
    /** @type {{ bibcode: string, title?: string, author?: string[], year?: number }[]} */
    const out = []
    const seen = new Set()
    for (const paper of papers) {
      if (!paper || typeof paper.bibcode !== 'string' || paper.bibcode.length === 0) continue
      if (seen.has(paper.bibcode)) continue
      seen.add(paper.bibcode)
      /** @type {{ bibcode: string, title?: string, author?: string[], year?: number }} */
      const ref = { bibcode: paper.bibcode }
      if (typeof paper.title === 'string') ref.title = paper.title
      if (Array.isArray(paper.author)) ref.author = paper.author.filter((a) => typeof a === 'string')
      if (typeof paper.year === 'number' && Number.isFinite(paper.year)) ref.year = paper.year
      out.push(ref)
    }
    return out
  }

  return {
    add(sessionKey, papers) {
      const { id, set } = resolve(sessionKey, undefined, true)
      const existing = new Set(set.papers.map((p) => p.bibcode))
      const excluded = new Set(set.excluded)
      /** @type {string[]} */
      const added = []
      for (const ref of cleanPapers(papers)) {
        if (existing.has(ref.bibcode) || excluded.has(ref.bibcode)) continue
        existing.add(ref.bibcode)
        set.papers.push(ref)
        added.push(ref.bibcode)
      }
      return { working_set_id: id, added, size: set.papers.length }
    },

    set(sessionKey, papers, workingSetId) {
      const { id, set } = resolve(sessionKey, workingSetId, true)
      const refs = cleanPapers(papers)
      const incoming = new Set(refs.map((p) => p.bibcode))
      set.papers = refs
      // Contract: clears exclusions for replaced members.
      set.excluded = set.excluded.filter((bibcode) => !incoming.has(bibcode))
      return { working_set_id: id, size: set.papers.length }
    },

    list(sessionKey) {
      const sets = sessionSets(sessionKey)
      return [...sets.entries()].map(([id, set]) => ({
        working_set_id: id,
        size: set.papers.length,
        excluded_count: set.excluded.length,
      }))
    },

    exclude(sessionKey, bibcodes, workingSetId) {
      const { id, set } = resolve(sessionKey, workingSetId, true)
      if (!Array.isArray(bibcodes)) throw new Error('bibcodes must be an array of strings')
      const already = new Set(set.excluded)
      /** @type {string[]} */
      const newly = []
      const targets = new Set()
      for (const bibcode of bibcodes) {
        if (typeof bibcode !== 'string' || bibcode.length === 0 || targets.has(bibcode)) continue
        targets.add(bibcode)
        if (!already.has(bibcode)) {
          already.add(bibcode)
          newly.push(bibcode)
        }
      }
      set.papers = set.papers.filter((p) => !targets.has(p.bibcode))
      set.excluded = [...already]
      return { working_set_id: id, excluded: newly, size: set.papers.length }
    },

    get(sessionKey, workingSetId) {
      const hit = resolve(sessionKey, workingSetId, false)
      if (!hit) return undefined
      return {
        working_set_id: hit.id,
        papers: hit.set.papers.map((p) => ({
          bibcode: p.bibcode,
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.author !== undefined ? { author: [...p.author] } : {}),
          ...(p.year !== undefined ? { year: p.year } : {}),
        })),
        excluded: [...hit.set.excluded],
        size: hit.set.papers.length,
      }
    },

    dispose() {
      sessions.clear()
    },
  }
}

/** @param {unknown} sessionKey */
function assertKey(sessionKey) {
  if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
    throw new Error('sessionKey must be a non-empty string')
  }
}
