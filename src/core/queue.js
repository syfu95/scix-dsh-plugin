/**
 * Dependency-free queue / timing / backoff math for the ADS API client.
 * NO dsh imports and NO Node builtins: plain `node --test` can import this
 * module directly (contracts/README.md test convention). All timing goes
 * through an injectable clock seam so tests run deterministically on a
 * virtual clock; production uses createRealClock().
 *
 * Concurrency model: every gate is a FIFO promise chain. acquire() calls
 * made synchronously in a loop are granted in call order; an aborted
 * acquire rejects without breaking the chain for later waiters.
 * @module core/queue
 */

/** Milliseconds in one UTC day (the ADS quota reset period). */
export const MS_PER_DAY = 86_400_000

/**
 * Build the abort rejection value for a signal: its reason when present,
 * otherwise a standard AbortError. Client code normalizes these into
 * ScixError(ABORTED); helpers stay error-class-free.
 * @param {AbortSignal} [signal]
 * @returns {unknown}
 */
export function abortError(signal) {
  if (signal && signal.reason !== undefined) return signal.reason
  return new DOMException('This operation was aborted', 'AbortError')
}

/**
 * Throw the signal's abort reason when already aborted.
 * @param {AbortSignal} [signal]
 */
export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError(signal)
}

/**
 * Real-time clock seam: Date.now + setTimeout. delay() clears its timer and
 * removes its abort listener on EVERY settle path (resolve, abort), so a
 * disposed client leaves no dangling timers or listeners.
 * @returns {{ now: () => number, delay: (ms: number, signal?: AbortSignal) => Promise<void> }}
 */
export function createRealClock() {
  return {
    now: () => Date.now(),
    delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(abortError(signal)); return }
        if (!(ms > 0)) { resolve(); return }
        const onAbort = () => {
          clearTimeout(timer)
          reject(abortError(signal))
        }
        const timer = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

/**
 * Deterministic virtual clock for unit tests. delay() registers a timer at
 * now()+ms; advance(ms) moves time forward and fires every timer due at or
 * before the target in chronological order (including timers scheduled by
 * earlier firings). Aborting a signal removes its pending timer immediately.
 * `pending` exposes the live timer count so dispose() tests can assert that
 * no timers survive. Promise continuations run as microtasks AFTER advance()
 * returns; tests must flush (e.g. await new Promise(setImmediate)) before
 * asserting.
 * @param {number} [startMs=0]
 */
export function createVirtualClock(startMs = 0) {
  let current = startMs
  let nextId = 1
  /** @type {Map<number, { at: number, resolve: () => void, reject: (e: unknown) => void, signal?: AbortSignal, onAbort: () => void }>} */
  const timers = new Map()
  return {
    now: () => current,
    delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) { reject(abortError(signal)); return }
        if (!(ms > 0)) { resolve(); return }
        const id = nextId++
        const onAbort = () => {
          timers.delete(id)
          reject(abortError(signal))
        }
        timers.set(id, { at: current + ms, resolve, reject, signal, onAbort })
        if (signal) signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    /** Advance time by ms, firing all due timers in order. Synchronous. */
    advance(ms) {
      const target = current + Math.max(0, ms)
      for (;;) {
        let dueId
        let dueAt = Infinity
        for (const [id, entry] of timers) {
          if (entry.at <= target && entry.at < dueAt) { dueAt = entry.at; dueId = id }
        }
        if (dueId === undefined) break
        const entry = timers.get(dueId)
        timers.delete(dueId)
        current = Math.max(current, entry.at)
        if (entry.signal) entry.signal.removeEventListener('abort', entry.onAbort)
        entry.resolve()
      }
      current = target
    },
    /** Number of live pending timers (0 after a clean dispose). */
    get pending() { return timers.size },
  }
}

/**
 * Generic FIFO gate: callers queue on a promise chain; each turn asks
 * tryGrant() for the wait in ms (0 = granted NOW, with any bookkeeping
 * side effect performed by tryGrant itself). While waiting, the signal is
 * honored; on abort the acquire rejects and the chain continues.
 * @param {{ clock: { now: () => number, delay: (ms: number, signal?: AbortSignal) => Promise<void> }, tryGrant: () => number }} options
 * @returns {{ acquire: (signal?: AbortSignal) => Promise<void> }}
 */
export function createFifoGate({ clock, tryGrant }) {
  let tail = Promise.resolve()
  return {
    acquire(signal) {
      const run = async () => {
        for (;;) {
          throwIfAborted(signal)
          const waitMs = tryGrant()
          if (!(waitMs > 0)) return
          await clock.delay(waitMs, signal)
        }
      }
      const granted = tail.then(run)
      // Keep the chain alive when one acquire rejects (abort/dispose).
      tail = granted.then(() => undefined, () => undefined)
      return granted
    },
  }
}

/**
 * Burst gate: at most `limit` grants in any rolling `windowMs` window
 * (token-bucket equivalent: capacity=limit, refill=limit/window). The first
 * `limit` callers pass immediately (burst); later callers wait FIFO until
 * the oldest grant leaves the window. ADS policy: 15 requests/second.
 * @param {{ limit: number, windowMs?: number, clock: object }} options
 */
export function createBurstGate({ limit, windowMs = 1000, clock }) {
  /** @type {number[]} grant timestamps inside the current window */
  const sends = []
  return createFifoGate({
    clock,
    tryGrant() {
      const now = clock.now()
      while (sends.length > 0 && sends[0] <= now - windowMs) sends.shift()
      if (sends.length < limit) { sends.push(now); return 0 }
      return sends[0] + windowMs - now
    },
  })
}

/**
 * Per-host conservative lane: at least `minIntervalMs` between grant times
 * (request STARTS), FIFO. Used for external hosts (arXiv family, Semantic
 * Scholar). In-flight requests may overlap; only starts are spaced.
 * @param {{ minIntervalMs: number, clock: object }} options
 */
export function createHostLane({ minIntervalMs, clock }) {
  let lastStart
  return createFifoGate({
    clock,
    tryGrant() {
      const now = clock.now()
      if (lastStart === undefined || now - lastStart >= minIntervalMs) {
        lastStart = now
        return 0
      }
      return lastStart + minIntervalMs - now
    },
  })
}

/** UTC day index of a millisecond timestamp (days since epoch). */
export function utcDayIndex(nowMs) {
  return Math.floor(nowMs / MS_PER_DAY)
}

/** Next midnight UTC at or after nowMs+1ms, in epoch ms. */
export function nextUtcMidnightMs(nowMs) {
  return (utcDayIndex(nowMs) + 1) * MS_PER_DAY
}

/**
 * Local daily quota counter (Agent.md §2.3 keeps the stricter 3000/day even
 * though the official policy says 5000). Resets when the UTC day changes.
 * tryConsume() is synchronous and sequential-safe: check-and-increment in
 * one turn, so concurrent callers can never overshoot the limit.
 * @param {{ limit: number, clock: { now: () => number } }} options
 */
export function createDailyQuota({ limit, clock }) {
  let day = utcDayIndex(clock.now())
  let used = 0
  const rollover = (now) => {
    const today = utcDayIndex(now)
    if (today !== day) { day = today; used = 0 }
  }
  return {
    /**
     * Consume one request slot.
     * @returns {{ ok: true, remaining: number } | { ok: false, remaining: 0, resetAtMs: number, retryAfterMs: number }}
     */
    tryConsume() {
      const now = clock.now()
      rollover(now)
      if (used >= limit) {
        const resetAtMs = nextUtcMidnightMs(now)
        return { ok: false, remaining: 0, resetAtMs, retryAfterMs: resetAtMs - now }
      }
      used += 1
      return { ok: true, remaining: limit - used }
    },
    /** Read-only state (rollover-aware); never consumes. */
    snapshot() {
      const now = clock.now()
      rollover(now)
      return { used, remaining: limit - used, limit, resetAtMs: nextUtcMidnightMs(now) }
    },
  }
}

/**
 * Parse a Retry-After header into milliseconds from now.
 * Accepts delay-seconds ("120") and HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT").
 * @param {string|null|undefined} value
 * @param {number} nowMs
 * @returns {number|undefined} non-negative ms, or undefined when absent/invalid
 */
export function parseRetryAfterMs(value, nowMs) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const dateMs = Date.parse(text)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs)
  return undefined
}

/**
 * Parse X-RateLimit-Reset (unix SECONDS) into epoch milliseconds.
 * @param {string|null|undefined} value
 * @returns {number|undefined}
 */
export function parseRateLimitResetMs(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '') return undefined
  const seconds = Number(text)
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return seconds * 1000
}

/**
 * One backoff wait: exponential base*2^attempt capped at maxMs, but the
 * server's instruction wins when larger — Retry-After and the wait until
 * X-RateLimit-Reset act as FLOORS (authoritative, uncapped). Deterministic
 * (no jitter) so tests can assert exact waits.
 * @param {{ attempt: number, baseMs: number, maxMs: number, retryAfterMs?: number, resetMs?: number, nowMs?: number }} options
 * @returns {number} ms to wait before the next attempt (attempt is 0-based)
 */
export function computeBackoffMs({ attempt, baseMs, maxMs, retryAfterMs, resetMs, nowMs }) {
  const exponential = Math.min(baseMs * 2 ** attempt, maxMs)
  let serverWait = 0
  if (retryAfterMs !== undefined) serverWait = Math.max(serverWait, retryAfterMs)
  if (resetMs !== undefined && nowMs !== undefined) serverWait = Math.max(serverWait, resetMs - nowMs)
  return Math.max(exponential, serverWait)
}
