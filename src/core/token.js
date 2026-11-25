/**
 * Token helpers + the Client-callable verify Remote endpoint.
 * Contract: src/contracts/token.js (constants stay authoritative there).
 *
 * Storage: the ADS token is a SECRET in ctx.credentials under the ref
 * TOKEN_CREDENTIAL_REF — NEVER row config, patch YAML, logs, or tool results
 * (dev brief §4.5; Agent.md §2.2). The ref is what the existing Client-callable
 * Host namespace ctx.remote.credentials.set/describe/unset writes, so the UI
 * Save button needs no custom write endpoint.
 *
 * Runtime note (verified installed source): credentialRef() from
 * @deepseek-ai/dsh-credentials is brandString() — a COMPILE-TIME-only brand
 * returning the same string (dsh-brand/src/index.ts). TOKEN_CREDENTIAL_REF
 * matches the ref grammar, so passing the constant directly to
 * ctx.credentials.resolve/set/unset is runtime-identical to wrapping it;
 * this module therefore needs no dsh-credentials import.
 *
 * Remote registration (plain-JS path, verified against installed sources —
 * no TS decorators, no build step):
 * - bindTypertRemote(service, key, { namespace }) is an exported plain
 *   function (dsh-typert-protocol/src/index.ts L236).
 * - Remote is a STANDARD decorator function; we call it directly with a
 *   synthesized decorator context and run its initializer once on a
 *   prototype-derived object. This writes exactly the frozen versioned
 *   descriptor `@Remote` would write (addMarkerInitializer/mark, L428-476).
 * - ctx.provide(key, service) registers a live {type:'service'} entry AND
 *   returns a real disposer (cordis reflect.ts L291) — unlike
 *   TypertRemoteService's super() provide, which discards its disposer.
 * - The compiled Gateway's SRC fallback discovers the binding + prototype
 *   markers and dispatches 'scix/verifyToken' with zero args
 *   (dsh-api-gateway/src/index.ts collectSrcClaims L401, resolveSrcDescriptor
 *   L891 — not dev-gated). Client call (ui, verified):
 *   ctx.connection.rpc.call('/api', 'scix/verifyToken', { args: {} }).
 * @module core/token
 */
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import {
  TOKEN_CREDENTIAL_REF,
  REMOTE_SERVICE_NAME,
  REMOTE_NAMESPACE,
  REMOTE_VERIFY_METHOD,
} from '../contracts/token.js'
import { CONFIG_DEFAULTS } from '../contracts/config.js'
import { ERROR_CODES, TOKEN_MISSING_MESSAGE } from '../contracts/errors.js'
import { ScixError } from './errors.js'

/**
 * Resolve the stored ADS token; undefined when absent. Never log the value.
 * Resolved per call so a rotated credential applies without restart.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<string|undefined>}
 */
export async function getToken(ctx) {
  const hit = await ctx.credentials.resolve(TOKEN_CREDENTIAL_REF)
  const value = hit?.value
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Store the user's ADS token (stored value outranks environment fallbacks).
 * Empty/whitespace values are rejected (the store refuses empty set anyway).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} value Non-empty token; surrounding whitespace is trimmed.
 * @returns {Promise<void>}
 */
export async function setToken(ctx, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ScixError(ERROR_CODES.API_ERROR, 'Cannot save an empty ADS token. Paste your full personal token (free at https://ui.adsabs.harvard.edu/user/settings/token), then save.')
  }
  await ctx.credentials.set(TOKEN_CREDENTIAL_REF, value.trim())
}

/**
 * Remove the stored token; no-op when absent.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<void>}
 */
export async function unsetToken(ctx) {
  await ctx.credentials.unset(TOKEN_CREDENTIAL_REF)
}

/**
 * Verify the token with ONE lightweight authenticated ADS probe:
 * GET search/query?q=*:*&rows=1&fl=id (scix-mcp health_check pattern).
 * Standalone fetch — not queued, no daily-quota consumption (one probe per
 * user action). Outcomes (contract addendum):
 * - missing token      → { ok:false, message: TOKEN_MISSING_MESSAGE }
 * - 2xx                → { ok:true, message, status }
 * - 401/403/429/other  → { ok:false, message, status }
 * - network/timeout    → { ok:false, message } (no status)
 * - caller abort       → throws ScixError(ABORTED)
 * Never echoes the token in any message.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ signal?: AbortSignal, apiBaseUrl?: string }} [options]
 * @returns {Promise<import('../contracts/token.js').TokenVerification>}
 */
export async function verifyToken(ctx, options = {}) {
  const base = String(options.apiBaseUrl ?? CONFIG_DEFAULTS.apiBaseUrl).replace(/\/+$/, '')
  const token = await getToken(ctx)
  if (!token) return { ok: false, message: TOKEN_MISSING_MESSAGE }
  const callerSignal = options.signal
  if (callerSignal?.aborted) {
    throw new ScixError(ERROR_CODES.ABORTED, 'Token verification was cancelled.')
  }
  const timeoutMs = CONFIG_DEFAULTS.requestTimeoutMs
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout.signal]) : timeout.signal
  let response
  try {
    response = await globalThis.fetch(`${base}/search/query?q=*:*&rows=1&fl=id`, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal,
    })
  } catch (err) {
    if (callerSignal?.aborted) {
      throw new ScixError(ERROR_CODES.ABORTED, 'Token verification was cancelled.', { cause: err })
    }
    const reason = timeout.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : (err instanceof Error ? err.message : String(err))
    return {
      ok: false,
      message: `Could not reach the ADS API at ${base} (${reason}). Check your network connection and the plugin's apiBaseUrl setting, then verify again.`,
    }
  } finally {
    clearTimeout(timer)
  }
  // Drain the small probe body so no connection lingers; ignore read faults.
  try {
    await response.text()
  } catch { /* body drain is best-effort */ }
  if (callerSignal?.aborted) {
    throw new ScixError(ERROR_CODES.ABORTED, 'Token verification was cancelled.')
  }
  const status = response.status
  const host = safeHost(base)
  if (response.ok) {
    return { ok: true, message: `Token verified against ${host} (HTTP ${status}).`, status }
  }
  if (status === 401) {
    return {
      ok: false,
      message: 'ADS rejected the token (HTTP 401). Copy your full personal token from https://ui.adsabs.harvard.edu/user/settings/token (SciX: https://scixplorer.org/user/settings/token), save it again, then verify.',
      status,
    }
  }
  if (status === 403) {
    return {
      ok: false,
      message: 'The token authenticated but lacks permission for this API (HTTP 403). Re-copy the token from your account settings; if it persists, contact ADS help (adshelp@cfa.harvard.edu).',
      status,
    }
  }
  if (status === 429) {
    return { ok: false, message: 'ADS rate limit reached (HTTP 429). Wait a minute, then verify again.', status }
  }
  return { ok: false, message: `ADS API returned HTTP ${status} during verification. Try again later.`, status }
}

/**
 * The Client-callable verify service. Plain JS class: the Gateway's SRC
 * discovery reads only (a) a live ctx service entry, (b) the typertRemote
 * binding, (c) prototype Remote markers — no base-class requirement
 * (dsh-api-gateway collectSrcClaims/readBinding, verified).
 */
class ScixController {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx
   * @param {string} apiBaseUrl
   */
  constructor(ctx, apiBaseUrl) {
    this.ctx = ctx
    this.apiBaseUrl = apiBaseUrl
    this.typertRemote = bindTypertRemote(this, REMOTE_SERVICE_NAME, { namespace: REMOTE_NAMESPACE })
  }

  /** Zero-arg endpoint method; SRC parses the empty parameter list. */
  async [REMOTE_VERIFY_METHOD]() {
    return verifyToken(this.ctx, { apiBaseUrl: this.apiBaseUrl })
  }
}

/**
 * Apply the standard `Remote` decorator as a plain function call (plain ESM
 * has no decorator syntax). Remote(method, context) schedules an initializer
 * that writes the versioned prototype descriptor; we run it once with `this`
 * bound to an object whose prototype is the class prototype — exactly the
 * state the runtime produces at instantiation (mark() is idempotent).
 * @param {Function} Class
 * @param {string} methodName
 */
function markRemoteMethod(Class, methodName) {
  let initializer
  Remote(Class.prototype[methodName], {
    kind: 'method',
    name: methodName,
    static: false,
    private: false,
    addInitializer(fn) { initializer = fn },
  })
  if (typeof initializer !== 'function') {
    throw new TypeError('typert-protocol: Remote did not schedule a marker initializer')
  }
  initializer.call(Object.create(Class.prototype))
}
markRemoteMethod(ScixController, REMOTE_VERIFY_METHOD)

/**
 * Register the verify endpoint: a live 'scixController' service bound to
 * namespace 'scix', method 'verifyToken' (zero args). Returns the ctx.provide
 * disposer; also auto-cleaned by fiber unload. Call inside apply/ctx.effect.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ apiBaseUrl?: string }} [config] Row config (only apiBaseUrl is read).
 * @returns {() => void} disposer
 */
export function registerVerifyRemote(ctx, config = {}) {
  const controller = new ScixController(ctx, config.apiBaseUrl ?? CONFIG_DEFAULTS.apiBaseUrl)
  return ctx.provide(REMOTE_SERVICE_NAME, controller)
}

function safeHost(base) {
  try {
    return new URL(base).host
  } catch {
    return base
  }
}
