/**
 * Shared test helpers (NOT a test file; the *.test.js glob never runs it).
 * Fake ctx.credentials, fetch stubs, response builders. No real network.
 */

/** Drain the microtask cascade after a synchronous virtual-clock advance. */
export const flush = () => new Promise(resolve => setImmediate(resolve))

/**
 * Minimal fake Host context: only ctx.credentials (what core code touches).
 * @param {{ token?: string|undefined, resolveImpl?: (ref: string) => unknown }} [options]
 */
export function makeCtx(options = {}) {
  // 'token' in options: an EXPLICIT undefined must mean "no token", not the default.
  const token = 'token' in options ? options.token : 'test-token-123'
  const resolveImpl = options.resolveImpl
  const calls = { resolve: [], set: [], unset: [] }
  return {
    calls,
    credentials: {
      async resolve(ref) {
        calls.resolve.push(ref)
        if (resolveImpl) return resolveImpl(ref)
        return token === undefined ? undefined : { value: token, source: 'user-env' }
      },
      async set(ref, value) { calls.set.push([ref, value]) },
      async unset(ref) { calls.unset.push(ref) },
    },
  }
}

/** Real Response with a JSON body (headers lowercased by the Headers class). */
export function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Response-like object with an explicit final URL (for redirect guards). */
export function rawResponse({ status = 200, headers = {}, text = '', url = '' }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers(headers),
    text: async () => text,
  }
}

/**
 * Recording fetch stub. responder(index, url, init) returns a Response
 * (or a promise of one). Calls record the virtual-clock time when provided.
 */
export function stubFetch(responder, clock) {
  const calls = []
  const fn = async (url, init) => {
    const index = calls.length
    calls.push({ url, init, at: clock ? clock.now() : Date.now(), index })
    return responder(index, url, init)
  }
  fn.calls = calls
  return fn
}

/** fetch stub that never settles until its signal aborts (in-flight work). */
export function hangingFetch(clock) {
  const calls = []
  const fn = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, at: clock ? clock.now() : Date.now() })
    const onAbort = () => reject(init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError'))
    if (init.signal.aborted) { onAbort(); return }
    init.signal.addEventListener('abort', onAbort, { once: true })
  })
  fn.calls = calls
  return fn
}

/** Standard non-secret row config for tests. */
export const TEST_CONFIG = { apiBaseUrl: 'https://api.example/v1', requestTimeoutMs: 30000 }
