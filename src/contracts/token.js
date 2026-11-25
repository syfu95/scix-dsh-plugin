/**
 * Token/credential contract. The ADS token is a SECRET: it lives in
 * ctx.credentials, NEVER in row config, patch YAML, logs, or tool results
 * (dev brief §4.5; Agent.md §2.2 — per-user token, no hardcoding/sharing).
 *
 * Canonical storage: credentialRef(TOKEN_CREDENTIAL_REF) via
 * ctx.credentials.resolve/set/unset. This ref is what the existing
 * Client-callable Host namespace `ctx.remote.credentials.set(ref, value)` /
 * `describe(refs)` / `unset(ref)` writes (dev brief §5 step 3), so the UI Save
 * button needs no custom write endpoint.
 *
 * Verify is implemented ONCE on the Host (verifyToken below) and exposed to
 * the UI through a TypertRemoteService named REMOTE_SERVICE_NAME with namespace
 * REMOTE_NAMESPACE → the browser calls
 * `ctx.remote[REMOTE_NAMESPACE][REMOTE_VERIFY_METHOD]()`.
 * The agent-facing path reuses the same function (one operation, two callers).
 * @module contracts/token
 */

/** Canonical credential ref name (POSIX shell identifier; wrap with credentialRef()). */
export const TOKEN_CREDENTIAL_REF = 'SCIX_API_TOKEN'

/**
 * Record-scope constants for the alternative credentialKey(owner, id) path
 * (dev brief §4.5). Canonical storage is the ref above; if an implementer
 * switches to records, both sides must use exactly this scope.
 */
export const TOKEN_RECORD_OWNER = 'scix-dsh-plugin'
export const TOKEN_RECORD_ID = 'ads-token'

/** TypertRemoteService registration name (Host core and UI must agree). */
export const REMOTE_SERVICE_NAME = 'scixController'
/** Remote namespace → browser calls ctx.remote.scix.verifyToken(). */
export const REMOTE_NAMESPACE = 'scix'
/** Remote method name for token verification. */
export const REMOTE_VERIFY_METHOD = 'verifyToken'

/**
 * @typedef {Object} TokenVerification
 * @property {boolean} ok True when the token authenticated against ADS.
 * @property {string} message Human-readable outcome (actionable on failure).
 * @property {number} [status] HTTP status of the verification probe, when sent.
 */

/**
 * @typedef {Object} TokenHelpers ctx-bound helper bundle passed to tools as deps.token.
 * @property {() => Promise<string|undefined>} getToken
 * @property {(value: string) => Promise<void>} setToken
 * @property {() => Promise<void>} unsetToken
 * @property {(options?: { signal?: AbortSignal, apiBaseUrl?: string }) => Promise<TokenVerification>} verifyToken
 */

/**
 * Function contracts (implemented in src/core/token.js):
 * - `getToken(ctx) → Promise<string|undefined>` — resolve the ref; undefined when
 *   absent. Never log or return the value through any read path except request auth.
 * - `setToken(ctx, value) → Promise<void>` — ctx.credentials.set(ref, value);
 *   empty/whitespace values are rejected (empty set is refused by the store).
 * - `unsetToken(ctx) → Promise<void>` — ctx.credentials.unset(ref); no-op when absent.
 * - `verifyToken(ctx, { signal, apiBaseUrl } = {}) → Promise<TokenVerification>` —
 *   one lightweight authenticated ADS probe (GET search/query?q=*:*&rows=1&fl=id).
 *   ADDENDUM 2026-11-25 (host-core; tools/ui/lead notified): resolves
 *   { ok:false, message } for missing token, 401/403/429/other non-2xx (with
 *   status when a response arrived) AND for network/timeout failures (no
 *   status) — the Verify button always gets a renderable message. Throws
 *   ScixError(ABORTED) ONLY on caller abort. apiBaseUrl is optional (defaults
 *   CONFIG_DEFAULTS.apiBaseUrl; src/index.js wires the row config through).
 *   Must not echo the token in messages.
 * - `registerVerifyRemote(ctx, config = {}) → () => void` — register the live
 *   REMOTE_SERVICE_NAME service bound to REMOTE_NAMESPACE exposing
 *   REMOTE_VERIFY_METHOD (zero args), delegating to verifyToken(ctx, { apiBaseUrl }).
 *   Returns the ctx.provide disposer; register inside ctx.effect.
 *   RESOLVED (was: flagged unverified, brief §11): the plain-JS path exists —
 *   bindTypertRemote() + the exported Remote() decorator called as a function
 *   with a synthesized standard-decorator context writes the same versioned
 *   prototype marker; the compiled Gateway's SRC fallback claims and dispatches
 *   'scix/verifyToken' in the built app. Client call (ui, verified):
 *   ctx.connection.rpc.call('/api', 'scix/verifyToken', { args: {} }) →
 *   { ok:true, value: TokenVerification } | { ok:false, error }.
 *   See src/core/token.js module doc for source line references.
 */