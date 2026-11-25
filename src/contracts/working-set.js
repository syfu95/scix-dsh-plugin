/**
 * WorkingSetStore contract: session-scoped dynamic paper sets (Agent.md §3).
 * Implemented by `src/tools/working-set.js` → `createWorkingSetStore()`.
 * In-memory only; lives for the plugin instance; dispose() clears everything
 * on unload. Used by search (auto-add hits), find_gaps, and citation tools.
 * @module contracts/working-set
 */

/** Generated working-set ids start with this prefix; ids are OPAQUE — never parse them. */
export const WORKING_SET_ID_PREFIX = 'ws-'
/** Each session's implicit default set; add/set/exclude without an id target it. */
export const DEFAULT_WORKING_SET_ID = 'ws-default'

/**
 * @typedef {Object} WorkingSet
 * @property {string} working_set_id
 * @property {import('./tools.js').PaperRef[]} papers Members, identifiers verbatim, insertion order.
 * @property {string[]} excluded Bibcodes explicitly excluded (kept known, filtered from analysis).
 * @property {number} size papers.length (excluded entries do not count).
 */

/**
 * @typedef {Object} WorkingSetSummary
 * @property {string} working_set_id
 * @property {number} size
 * @property {number} excluded_count
 */

/**
 * @typedef {Object} WorkingSetStore
 * @property {(sessionKey: string, papers: import('./tools.js').PaperRef[]) =>
 *   { working_set_id: string, added: string[], size: number }} add
 *   Add papers to the session's default set (auto-created); dedupe by bibcode;
 *   `added` lists only newly inserted bibcodes.
 * @property {(sessionKey: string, papers: import('./tools.js').PaperRef[], workingSetId?: string) =>
 *   { working_set_id: string, size: number }} set
 *   Replace membership of the target set (default when omitted); creates the
 *   set when an explicit workingSetId is new. Clears exclusions for replaced members.
 * @property {(sessionKey: string) => WorkingSetSummary[]} list
 *   All sets owned by the session; [] when none. Never leaks other sessions.
 * @property {(sessionKey: string, bibcodes: string[], workingSetId?: string) =>
 *   { working_set_id: string, excluded: string[], size: number }} exclude
 *   Mark bibcodes excluded in the target set; `excluded` lists newly excluded ones.
 * @property {(sessionKey: string, workingSetId?: string) => WorkingSet | undefined} get
 *   Full snapshot (default set when omitted); undefined when absent.
 * @property {() => void} dispose Clear all sessions; idempotent.
 */

/**
 * Factory contract: `createWorkingSetStore() → WorkingSetStore`.
 * sessionKey is supplied by callers (see contracts/tools.js session-scoping note).
 * Snapshots returned by get/list must be copies — callers cannot mutate store state.
 */