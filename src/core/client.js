/**
 * Queued ADS/SciX API client + conservative external-host fetcher.
 * Contract: src/contracts/api-client.js (incl. the requestExternal addendum).
 *
 * Seams (test-only, optional 3rd argument; production calls use defaults):
 *   createApiClient(ctx, config, { fetch, clock, quotaLimit, burstLimit,
 *     max429Retries, externalMinIntervalMs, externalMaxRetries })
 * - fetch defaults to globalThis.fetch (tests stub it; never hit real APIs).
 * - clock defaults to createRealClock(); tests inject createVirtualClock().
 * Queue/backoff/quota math lives in ./queue.js (dependency-free).
 *
 * Hard rules enforced here (Agent.md):
 * - §2.1 never request PDF endpoints; refuse PDF paths, PDF redirects and
 *   application/pdf responses on BOTH seams.
 * - §2.3 ≤ BURST_LIMIT_PER_SECOND/s burst queue, DAILY_REQUEST_QUOTA/day
 *   local counter (midnight UTC reset), 429 exponential backoff honoring
 *   Retry-After / X-RateLimit-Reset, bounded retries.
 * - §5 dispose() cancels/drains ALL pending work (ADS + external): every
 *   wait and fetch is linked to one internal AbortController; no dangling
 *   requests or timers survive. Idempotent.
 * @module core/client
 */
import {
  BURST_LIMIT_PER_SECOND,
  DAILY_REQUEST_QUOTA,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  MAX_429_RETRIES,
} from '../contracts/api-client.js'
import { ERROR_CODES, TOKEN_MISSING_MESSAGE } from '../contracts/errors.js'
import { CONFIG_DEFAULTS } from '../contracts/config.js'
import { ScixError } from './errors.js'
import { getToken } from './token.js'
import {
  createRealClock,
  createBurstGate,
  createDailyQuota,
  createHostLane,
  computeBackoffMs,
  parseRetryAfterMs,
  parseRateLimitResetMs,
  throwIfAborted,
} from './queue.js'

/** Conservative external pacing: ≥1000ms between request starts per lane. */
const EXTERNAL_MIN_INTERVAL_MS = 1000
/** External retries on 429/503 (≤2 retries = ≤3 sends per call). */
const EXTERNAL_MAX_RETRIES = 2
/** arXiv family shares ONE lane (same infrastructure; conservative). */
const ARXIV_HOSTS = new Set(['arxiv.org', 'ar5iv.labs.arxiv.org', 'export.arxiv.org'])
const S2_HOSTS = new Set(['api.semanticscholar.org'])

/**
 * Create the singleton queued client for this plugin instance.
 * @param {import('@deepseek-ai/cordis').Context} ctx Host context (credentials access).
 * @param {import('../contracts/config.js').PluginConfig} config Validated row config.
 * @param {{ fetch?: typeof globalThis.fetch, clock?: ReturnType<typeof createRealClock>, quotaLimit?: number, burstLimit?: number, max429Retries?: number, externalMinIntervalMs?: number, externalMaxRetries?: number }} [seams] TEST-ONLY overrides.
 * @returns {import('../contracts/api-client.js').ApiClient}
 */
export function createApiClient(ctx, config, seams = {}) {
  const apiBaseUrl = String(config?.apiBaseUrl ?? CONFIG_DEFAULTS.apiBaseUrl).replace(/\/+$/, '')
  const requestTimeoutMs = config?.requestTimeoutMs ?? CONFIG_DEFAULTS.requestTimeoutMs
  const fetchImpl = seams.fetch ?? globalThis.fetch
  const clock = seams.clock ?? createRealClock()
  const max429Retries = seams.max429Retries ?? MAX_429_RETRIES
  const externalMaxRetries = seams.externalMaxRetries ?? EXTERNAL_MAX_RETRIES
  const burstGate = createBurstGate({ limit: seams.burstLimit ?? BURST_LIMIT_PER_SECOND, clock })
  const dailyQuota = createDailyQuota({ limit: seams.quotaLimit ?? DAILY_REQUEST_QUOTA, clock })
  /** @type {Map<string, { acquire: (signal?: AbortSignal) => Promise<void> }>} */
  const lanes = new Map()
  /** Per-endpoint X-RateLimit facts (authoritative when present). Key = first path segment. */
  const endpointLimits = new Map()
  const internal = new AbortController()
  let disposed = false

  // ---------------------------------------------------------------- helpers

  function assertAlive() {
    if (disposed) {
      throw new ScixError(ERROR_CODES.ABORTED, 'The SciX API client is disposed (plugin unloaded). Reload the plugin to make requests.')
    }
  }

  /** Link the caller signal (if any) to the internal dispose controller. */
  function linkSignal(callerSignal) {
    return callerSignal ? AbortSignal.any([internal.signal, callerSignal]) : internal.signal
  }

  function abortScix(cause) {
    if (cause instanceof ScixError && cause.code === ERROR_CODES.ABORTED) return cause
    return new ScixError(
      ERROR_CODES.ABORTED,
      disposed ? 'Request cancelled: the SciX API client was disposed.' : 'Request aborted by the caller.',
      { cause },
    )
  }

  /** Normalize any non-ScixError failure of a request body into a typed error. */
  function normalizeFailure(err, signal, target) {
    if (err instanceof ScixError) return err
    if (signal.aborted) return abortScix(err)
    return new ScixError(
      ERROR_CODES.API_ERROR,
      `Could not reach ${target}: ${err instanceof Error ? err.message : String(err)}. Check your network connection and try again.`,
      { cause: err },
    )
  }

  /** fetch with a per-attempt timeout; the timer is ALWAYS cleared on settle. */
  async function fetchWithTimeout(url, init, signal) {
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(), requestTimeoutMs)
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.any([signal, timeout.signal]) })
    } catch (err) {
      if (signal.aborted) throw abortScix(err)
      if (timeout.signal.aborted) {
        throw new ScixError(ERROR_CODES.API_ERROR, `Request to ${url} timed out after ${requestTimeoutMs}ms.`, { cause: err })
      }
      throw err // network fault; normalized by the caller's catch
    } finally {
      clearTimeout(timer)
    }
  }

  function laneFor(hostname) {
    const key = ARXIV_HOSTS.has(hostname) ? 'arxiv' : S2_HOSTS.has(hostname) ? 's2' : `host:${hostname}`
    let lane = lanes.get(key)
    if (lane === undefined) {
      lane = createHostLane({ minIntervalMs: seams.externalMinIntervalMs ?? EXTERNAL_MIN_INTERVAL_MS, clock })
      lanes.set(key, lane)
    }
    return lane
  }

  /** X-RateLimit-* headers are authoritative for the endpoint when present. */
  function observeRateHeaders(endpoint, headers) {
    const remainingRaw = headers.get('x-ratelimit-remaining')
    const resetMs = parseRateLimitResetMs(headers.get('x-ratelimit-reset'))
    const remaining = remainingRaw === null ? undefined : Number(remainingRaw)
    if ((remaining === undefined || !Number.isFinite(remaining)) && resetMs === undefined) return
    const prev = endpointLimits.get(endpoint)
    endpointLimits.set(endpoint, {
      remaining: remaining !== undefined && Number.isFinite(remaining) ? remaining : (prev?.remaining ?? Infinity),
      resetMs: resetMs ?? prev?.resetMs ?? 0,
    })
  }

  // ------------------------------------------------------------- ADS request

  /**
   * Queued ADS/SciX API request. Resolves the parsed JSON body on 2xx.
   * @param {string} path Relative to config.apiBaseUrl, e.g. '/search/query'.
   * @param {import('../contracts/api-client.js').RequestOptions} [options]
   * @returns {Promise<unknown>}
   */
  async function request(path, options = {}) {
    assertAlive()
    if (typeof path !== 'string' || path.length === 0) {
      throw new ScixError(ERROR_CODES.API_ERROR, 'client.request(path) requires a non-empty API path string.')
    }
    assertNotPdf(path.split('?')[0])
    const method = String(options.method ?? 'GET').toUpperCase()
    const url = buildUrl(apiBaseUrl, path, options.params)
    const signal = linkSignal(options.signal)
    const endpoint = endpointKeyOf(path)
    try {
      await burstGate.acquire(signal)
      for (let attempt = 0; ; attempt++) {
        throwIfAborted(signal)
        // Token resolved at SEND time: rotated credentials apply without restart.
        const token = await getToken(ctx)
        if (!token) throw new ScixError(ERROR_CODES.TOKEN_MISSING, TOKEN_MISSING_MESSAGE)
        const quota = dailyQuota.tryConsume()
        if (!quota.ok) {
          throw new ScixError(
            ERROR_CODES.QUOTA_EXCEEDED,
            `Local daily ADS request quota (${dailyQuota.snapshot().limit}) exhausted. It resets at ${new Date(quota.resetAtMs).toISOString()} (midnight UTC); retry in ${Math.ceil(quota.retryAfterMs / 1000)}s.`,
            { retryAfterMs: quota.retryAfterMs },
          )
        }
        const now = clock.now()
        const ep = endpointLimits.get(endpoint)
        if (ep && ep.remaining <= 0 && ep.resetMs > now) {
          throw new ScixError(
            ERROR_CODES.QUOTA_EXCEEDED,
            `ADS reports the "${endpoint}" endpoint quota exhausted (X-RateLimit-Remaining: 0). It resets at ${new Date(ep.resetMs).toISOString()}; retry in ${Math.ceil((ep.resetMs - now) / 1000)}s.`,
            { retryAfterMs: ep.resetMs - now },
          )
        }
        /** @type {Record<string, string>} */
        const headers = { Accept: 'application/json' }
        for (const [key, value] of Object.entries(options.headers ?? {})) {
          // Strip ALL case variants: fetch's Headers would comma-join duplicates,
          // so a caller 'authorization' must never ride alongside the stored token.
          if (key.toLowerCase() === 'authorization') continue
          headers[key] = value
        }
        let body
        if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
          body = JSON.stringify(options.body)
          if (!Object.keys(headers).some(key => key.toLowerCase() === 'content-type')) {
            headers['Content-Type'] = 'application/json'
          }
        }
        // Authorization ALWAYS comes from the stored token, never caller headers.
        headers.Authorization = `Bearer ${token}`
        const response = await fetchWithTimeout(url, { method, headers, body }, signal)
        observeRateHeaders(endpoint, response.headers)
        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), clock.now())
          const resetMs = parseRateLimitResetMs(response.headers.get('x-ratelimit-reset'))
          const waitMs = computeBackoffMs({ attempt, baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS, retryAfterMs, resetMs, nowMs: clock.now() })
          if (attempt >= max429Retries) {
            throw new ScixError(
              ERROR_CODES.RATE_LIMITED,
              `ADS rate limit (HTTP 429) persists after ${max429Retries} retries. Retry in ~${Math.ceil(waitMs / 1000)}s (respect Retry-After / X-RateLimit-Reset).`,
              { status: 429, retryAfterMs: waitMs },
            )
          }
          await clock.delay(waitMs, signal)
          continue
        }
        if (!response.ok) {
          const detail = await errorDetail(response)
          throw new ScixError(
            ERROR_CODES.API_ERROR,
            `ADS API returned HTTP ${response.status} for ${method} ${path}${detail}`,
            { status: response.status },
          )
        }
        const text = await response.text()
        try {
          return JSON.parse(text)
        } catch (cause) {
          throw new ScixError(ERROR_CODES.API_ERROR, `ADS API returned invalid JSON for ${method} ${path} (HTTP ${response.status}).`, { status: response.status, cause })
        }
      }
    } catch (err) {
      throw normalizeFailure(err, signal, `the ADS API at ${apiBaseUrl}`)
    }
  }

  // -------------------------------------------------------- external request

  /**
   * Conservative raw fetch for external hosts (arXiv HTML/ar5iv, Semantic
   * Scholar). RESOLVES { status, headers, text } even on non-2xx after
   * bounded retries — the caller parses/degrades. NEVER sends Authorization,
   * NEVER consumes the ADS daily quota. See contracts/api-client.js addendum.
   * @param {string} url Absolute http(s) URL.
   * @param {{ method?: string, signal?: AbortSignal, accept?: string, headers?: Record<string, string> }} [options]
   * @returns {Promise<{ status: number, headers: Record<string, string>, text: string }>}
   */
  async function requestExternal(url, options = {}) {
    assertAlive()
    let parsed
    try {
      parsed = new URL(url)
    } catch (cause) {
      throw new ScixError(ERROR_CODES.API_ERROR, `requestExternal: invalid URL ${JSON.stringify(url)}.`, { cause })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ScixError(ERROR_CODES.API_ERROR, 'requestExternal: only http(s) URLs are allowed.')
    }
    assertNotPdf(parsed.pathname)
    const method = String(options.method ?? 'GET').toUpperCase()
    const signal = linkSignal(options.signal)
    const lane = laneFor(parsed.hostname)
    /** @type {Record<string, string>} */
    const headers = { Accept: options.accept ?? 'application/json' }
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      // NO Authorization header ever reaches an external host (Agent.md §2.2).
      if (key.toLowerCase() === 'authorization') continue
      headers[key] = value
    }
    try {
      for (let attempt = 0; ; attempt++) {
        await lane.acquire(signal)
        const response = await fetchWithTimeout(parsed.href, { method, headers, redirect: 'follow' }, signal)
        // PDF guard on the FINAL URL (redirects included) and content type.
        const finalPath = safePathname(response.url) ?? parsed.pathname
        const contentType = response.headers.get('content-type') ?? ''
        if (isPdfPath(finalPath) || /application\/pdf/i.test(contentType)) {
          throw new ScixError(ERROR_CODES.API_ERROR, `Refusing PDF content from ${parsed.hostname} (plugin policy forbids PDF downloads).`)
        }
        const text = await response.text() // UTF-8 per the fetch spec
        /** @type {Record<string, string>} */
        const headerObj = {}
        response.headers.forEach((value, key) => { headerObj[key] = value })
        if ((response.status === 429 || response.status === 503) && attempt < externalMaxRetries) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), clock.now())
          const waitMs = computeBackoffMs({ attempt, baseMs: BACKOFF_BASE_MS, maxMs: BACKOFF_MAX_MS, retryAfterMs, nowMs: clock.now() })
          await clock.delay(waitMs, signal)
          continue
        }
        return { status: response.status, headers: headerObj, text }
      }
    } catch (err) {
      throw normalizeFailure(err, signal, parsed.hostname)
    }
  }

  // ----------------------------------------------------------------- dispose

  /**
   * Cancel/drain ALL pending work (ADS queue + external lanes + in-flight
   * fetches). Idempotent; later request/requestExternal calls throw ABORTED.
   */
  function dispose() {
    if (disposed) return
    disposed = true
    internal.abort(new ScixError(ERROR_CODES.ABORTED, 'The SciX API client was disposed; pending work cancelled.'))
  }

  return { request, requestExternal, dispose }
}

// ---------------------------------------------------------- pure URL helpers

/**
 * Join base + path and encode query params. undefined/null values are
 * omitted; arrays become repeated keys (ADS fq); everything else String().
 * @param {string} base
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 */
export function buildUrl(base, path, params) {
  const normalized = path.startsWith('/') ? path : `/${path}`
  let url = base + normalized
  if (params) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) search.append(key, String(item))
        }
      } else {
        search.append(key, String(value))
      }
    }
    const qs = search.toString()
    if (qs !== '') url += (url.includes('?') ? '&' : '?') + qs
  }
  return url
}

/** Endpoint bucket for per-endpoint X-RateLimit facts: first path segment. */
export function endpointKeyOf(path) {
  return path.replace(/^\/+/, '').split('?')[0].split('/')[0] || 'root'
}

/** True for PDF-looking URL paths (Agent.md §2.1: never touch PDF streams). */
export function isPdfPath(pathname) {
  return /(^|\/)pdf(\/|$)/i.test(pathname) || /\.pdf$/i.test(pathname)
}

function assertNotPdf(pathname) {
  if (isPdfPath(pathname)) {
    throw new ScixError(ERROR_CODES.API_ERROR, `Refusing PDF endpoint ${JSON.stringify(pathname)}: plugin policy forbids downloading PDFs (Agent.md §2.1). Use metadata/text sources instead.`)
  }
}

function safePathname(url) {
  try {
    return new URL(url).pathname
  } catch {
    return undefined
  }
}

/** Best-effort API error message excerpt for non-2xx responses (never the token). */
async function errorDetail(response) {
  try {
    const text = await response.text()
    if (!text) return ''
    try {
      const parsed = JSON.parse(text)
      const message = parsed?.message ?? parsed?.error
      if (typeof message === 'string' && message.length > 0) return `: ${message.slice(0, 300)}`
    } catch { /* not JSON */ }
    return `: ${text.slice(0, 200)}`
  } catch {
    return ''
  }
}
