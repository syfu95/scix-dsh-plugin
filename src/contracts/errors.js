/**
 * Typed error convention shared by the API client, token helpers, and tools.
 *
 * Runtime class: `ScixError` in `src/core/errors.js` extends `HarnessError`
 * from `@deepseek-ai/dsh-error` (verified installed source:
 * `constructor(message: string, code: string, options?: ErrorOptions)`,
 * readonly `code`, `name` = subclass constructor name). Per the dev brief
 * §4.3, ONLY a `HarnessError` subclass keeps `error.name`/`error.code` on a
 * tool result; a plain Error surfaces to the model as `Error: <message>`.
 *
 * This contracts module stays dependency-free (importable by plain node);
 * it defines codes and messages, not the runtime class.
 * @module contracts/errors
 */

/** Stable machine-routable failure codes. Route on `code`, never parse `message`. */
export const ERROR_CODES = Object.freeze({
  /** No ADS token stored. Message must tell the user exactly where to set it. */
  TOKEN_MISSING: 'TOKEN_MISSING',
  /** HTTP 429 burst limit (15 req/s) after bounded exponential backoff retries. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Local 3000/day quota counter exhausted; retry after the daily reset. */
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  /** Any other non-2xx ADS API response; carries `status`. */
  API_ERROR: 'API_ERROR',
  /** Caller aborted via exec.signal / client dispose; mirrors host ABORTED. */
  ABORTED: 'ABORTED',
})

/** Actionable first-use message (Agent.md §5: no uncaught exception on missing token). */
export const TOKEN_MISSING_MESSAGE =
  'No ADS API token is configured. Open Plugins → SciX → Configure, paste your personal ADS token ' +
  '(free at https://ui.adsabs.harvard.edu/user/settings/token), then save and verify it.'

/**
 * Extra fields carried by ScixError (see src/core/errors.js).
 * @typedef {Object} ScixErrorOptions
 * @property {number} [status] HTTP status for API_ERROR / RATE_LIMITED.
 * @property {number} [retryAfterMs] Suggested wait before retry (429 backoff / quota reset).
 * @property {unknown} [cause] Standard ErrorOptions cause chain.
 */

/**
 * Contract: every expected failure thrown by client/token/tool code is a
 * ScixError with one of ERROR_CODES and an actionable, user-facing message.
 * Tools must NOT catch-and-stringify these into prose results; let them throw
 * so the registry marks isError and preserves name/code.
 */