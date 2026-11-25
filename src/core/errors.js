/**
 * ScixError: the plugin's typed error (contracts/errors.js convention).
 * Extends HarnessError so tool results preserve error.name / error.code
 * (dev brief §4.3). Verified installed API: @deepseek-ai/dsh-error exports
 * HarnessError with constructor(message, code, options?: ErrorOptions).
 * @module core/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-error'

export class ScixError extends HarnessError {
  /**
   * @param {string} code One of import('../contracts/errors.js').ERROR_CODES.
   * @param {string} message Actionable, user-facing message (never contains the token).
   * @param {import('../contracts/errors.js').ScixErrorOptions} [options]
   */
  constructor(code, message, options = {}) {
    super(message, code, { cause: options.cause })
    /** @type {number|undefined} HTTP status when the failure came from an API response. */
    this.status = options.status
    /** @type {number|undefined} Suggested wait before retry (backoff / quota reset). */
    this.retryAfterMs = options.retryAfterMs
  }
}