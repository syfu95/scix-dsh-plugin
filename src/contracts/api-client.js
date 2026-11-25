/**
 * ApiClient contract: the single queued HTTP seam to the ADS/SciX API.
 * Implemented by `src/core/client.js` → `createApiClient(ctx, config)`.
 *
 * Hard semantics (Agent.md §2.3, dev brief):
 * - Burst queue: at most {@link BURST_LIMIT_PER_SECOND} requests per second;
 *   excess requests wait in FIFO order, never run as a concurrent burst.
 * - Daily quota: a local counter caps {@link DAILY_REQUEST_QUOTA} requests per
 *   day; when exhausted, reject with QUOTA_EXCEEDED + retryAfterMs (do not send).
 * - 429 handling: exponential backoff starting at BACKOFF_BASE_MS, capped at
 *   BACKOFF_MAX_MS, at most MAX_429_RETRIES attempts; honor a Retry-After
 *   header when present. After retries are exhausted throw RATE_LIMITED.
 * - dispose(): cancel queued work and abort in-flight requests (internal
 *   AbortController linked to each caller signal); no dangling requests may
 *   survive plugin unload. Idempotent.
 * - Every request resolves the token via the token contract at send time
 *   (rotated credentials apply without restart); missing token → TOKEN_MISSING
 *   with TOKEN_MISSING_MESSAGE, never an uncaught/untyped exception.
 * - NEVER request PDF endpoints or follow PDF redirects (Agent.md §2.1).
 * @module contracts/api-client
 */

/** ADS burst limit (requests per second). */
export const BURST_LIMIT_PER_SECOND = 15
/** ADS daily request quota per token. */
export const DAILY_REQUEST_QUOTA = 3000
/** First 429 backoff wait (ms); doubles per retry. */
export const BACKOFF_BASE_MS = 1000
/** Upper bound for one backoff wait (ms). */
export const BACKOFF_MAX_MS = 60000
/** Maximum 429 retry attempts before throwing RATE_LIMITED. */
export const MAX_429_RETRIES = 5

/**
 * @typedef {Object} RequestOptions
 * @property {string} [method='GET'] HTTP method.
 * @property {Record<string, string|number|boolean|undefined>} [params] Query-string
 *   parameters; undefined values are omitted. Arrays are passed as repeated keys
 *   only where the ADS endpoint documents them.
 * @property {unknown} [body] JSON-serializable body for POST/PUT (JSON.stringify'd;
 *   Content-Type: application/json is set unless caller headers provide one).
 * @property {AbortSignal} [signal] Caller cancellation (pass exec.signal through).
 * @property {Record<string, string>} [headers] Extra request headers (addendum
 *   2026-11-25). Authorization is ALWAYS overwritten with the stored token.
 */

/**
 * @typedef {Object} ApiClient
 * @property {(path: string, options?: RequestOptions) => Promise<unknown>} request
 *   `path` is relative to config.apiBaseUrl (e.g. '/search/query'). Resolves to
 *   the parsed JSON body on 2xx; throws ScixError (contracts/errors.js) otherwise.
 *   Identifiers in the response are returned VERBATIM — no rewriting anywhere.
 * @property {(url: string, options?: ExternalRequestOptions) => Promise<ExternalResponse>} requestExternal
 *   Conservative raw fetch for NON-ADS hosts (addendum 2026-11-25; exact
 *   semantics in the addendum block at the bottom of this file).
 * @property {() => void} dispose Cancel queue + in-flight work (ADS AND
 *   external); idempotent; later calls throw ScixError(ABORTED).
 */

/**
 * @typedef {Object} ExternalRequestOptions
 * @property {string} [method='GET'] HTTP method.
 * @property {AbortSignal} [signal] Caller cancellation; abort/dispose throws
 *   ScixError(ABORTED) — callers must rethrow aborts, never degrade them.
 * @property {string} [accept='application/json'] Accept header value.
 * @property {Record<string, string>} [headers] Extra headers. An Authorization
 *   header is STRIPPED (case-insensitive); no credentials ever reach external hosts.
 */

/**
 * @typedef {Object} ExternalResponse
 * @property {number} status HTTP status — returned RAW, including non-2xx
 *   (404/429/503…) after bounded retries, so callers can degrade honestly.
 * @property {Record<string, string>} headers Response headers, lowercased names.
 * @property {string} text Response body decoded as UTF-8; the CALLER parses JSON.
 */

/**
 * Factory contract (implemented in src/core/client.js):
 * `createApiClient(ctx, config, seams?) → ApiClient`
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context (credentials access).
 * @param {import('./config.js').PluginConfig} config Validated row config.
 * @param {Object} [seams] TEST-ONLY overrides (addendum 2026-11-25); production
 *   calls pass nothing. Keys: fetch (defaults globalThis.fetch), clock
 *   (defaults core/queue.js createRealClock(); tests inject createVirtualClock()),
 *   quotaLimit, burstLimit, max429Retries, externalMinIntervalMs, externalMaxRetries.
 * @returns {ApiClient}
 *
 * Implementation note: keep the queue/backoff/quota math in a dependency-free
 * helper (e.g. src/core/queue.js) so `node --test` can cover it with mocked fetch.
 */

/* =========================================================================
 * ADDENDUM 2026-11-25 (host-core, recorded; tools/ui/lead notified) —
 * requestExternal: the second HTTP seam, for arXiv HTML/ar5iv and Semantic
 * Scholar. Exact signature the tools agent codes against:
 *
 *   requestExternal(url, { method = 'GET', signal, accept = 'application/json',
 *                          headers } = {})
 *     → Promise<{ status: number, headers: Record<string,string>, text: string }>
 *
 * Semantics (implemented in src/core/client.js, tested in test/core/):
 * - RAW result: RESOLVES with the actual status even on non-2xx (404 arXiv
 *   HTML, 429 S2, …) after bounded retries; the caller parses text (UTF-8)
 *   and degrades honestly. headers names are lowercased.
 * - THROWS only: ScixError(ABORTED) on caller abort or client dispose
 *   (rethrow, never degrade); ScixError(API_ERROR, { cause }) on transport
 *   failure/timeout; ScixError(API_ERROR) when the URL, the FINAL redirect
 *   URL, or the response content-type is PDF (Agent.md §2.1 hard guard).
 * - NO Authorization header is ever sent to external hosts; a caller-supplied
 *   Authorization header is stripped case-insensitively.
 * - Per-host conservative lanes, ≥1000ms between request STARTS (FIFO):
 *   arxiv.org + ar5iv.labs.arxiv.org + export.arxiv.org share ONE lane;
 *   api.semanticscholar.org has its own lane; any other host gets its own
 *   1000ms lane. In-flight requests may overlap; starts are spaced.
 * - Retries: ≤2 retries (≤3 sends) per call on 429/503; wait =
 *   max(1000·2^attempt capped at 60000, Retry-After) — server instruction
 *   wins. After exhaustion the last raw response is returned.
 * - External calls do NOT consume the ADS daily quota and do NOT pass
 *   through the ADS burst gate.
 * - The SAME dispose() cancels queued/in-flight external work.
 *
 * Also recorded: RequestOptions gained optional `headers`; request() counts
 * every send attempt (incl. 429 retries) against the local daily counter;
 * X-RateLimit-Remaining/Reset are tracked per endpoint (first path segment)
 * and are authoritative when present (remaining 0 + future reset →
 * QUOTA_EXCEEDED with retryAfterMs until reset).
 * ========================================================================= */