/**
 * ADS request path: burst spacing, quota + UTC reset, 429 backoff/Retry-After/
 * max-retries, TOKEN_MISSING, API_ERROR, abort, dispose, token rotation,
 * PDF guard. Fetch is ALWAYS stubbed; timing uses the virtual clock seam.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { flush, makeCtx, jsonResponse, stubFetch, hangingFetch, TEST_CONFIG } from './helpers.mjs'

register('./dsh-stubs.mjs', import.meta.url)
const { createApiClient } = await import('../../src/core/client.js')
const { ScixError } = await import('../../src/core/errors.js')
const { createVirtualClock } = await import('../../src/core/queue.js')
const { ERROR_CODES, TOKEN_MISSING_MESSAGE } = await import('../../src/contracts/errors.js')

/** Assert a rejection is a ScixError with the given code; return it. */
async function expectScix(promise, code) {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof ScixError, `expected ScixError, got ${err?.name}: ${err?.message}`)
    assert.equal(err.code, code)
    assert.equal(err.name, 'ScixError')
    return err
  }
  assert.fail(`expected ScixError(${code}) but the promise resolved`)
}

test('burst spacing: 20 concurrent searches → 15 sends at t=0, 5 at t=1000', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, { response: { docs: [] } }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promises = Array.from({ length: 20 }, (_, i) => client.request('/search/query', { params: { q: `t${i}` } }))
  await flush()
  assert.equal(fetch.calls.length, 15)
  assert.deepEqual(fetch.calls.map(c => c.at), Array(15).fill(0))
  clock.advance(999)
  await flush()
  assert.equal(fetch.calls.length, 15)
  clock.advance(1)
  await flush()
  assert.equal(fetch.calls.length, 20)
  assert.deepEqual(fetch.calls.slice(15).map(c => c.at), [1000, 1000, 1000, 1000, 1000])
  await Promise.all(promises)
  assert.equal(clock.pending, 0)
  client.dispose()
})

test('URL building, Bearer auth, params encoding (arrays → repeated keys, undefined omitted)', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, { ok: true }), clock)
  const client = createApiClient(makeCtx({ token: 'tok-abc' }), TEST_CONFIG, { fetch, clock })
  const result = await client.request('/search/query', {
    params: { q: 'black hole', rows: 10, fq: ['year:2020', 'doctype:article'], skip: undefined, flag: false },
  })
  assert.deepEqual(result, { ok: true })
  const call = fetch.calls[0]
  const url = new URL(call.url)
  assert.equal(url.origin + url.pathname, 'https://api.example/v1/search/query')
  assert.equal(url.searchParams.get('q'), 'black hole')
  assert.equal(url.searchParams.get('rows'), '10')
  assert.deepEqual(url.searchParams.getAll('fq'), ['year:2020', 'doctype:article'])
  assert.equal(url.searchParams.has('skip'), false)
  assert.equal(url.searchParams.get('flag'), 'false')
  assert.equal(call.init.headers.Authorization, 'Bearer tok-abc')
  assert.equal(call.init.headers.Accept, 'application/json')
  assert.equal(call.init.method, 'GET')
  client.dispose()
})

test('POST JSON body + content-type; caller headers merged, Authorization always from the token', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, { export: '@article{...}' }), clock)
  const client = createApiClient(makeCtx({ token: 'real-token' }), TEST_CONFIG, { fetch, clock })
  await client.request('/export/bibtex', {
    method: 'POST',
    body: { bibcode: ['2020ApJ...900..123A'] },
    headers: { 'X-Custom': '1', Authorization: 'Bearer attacker' },
  })
  const call = fetch.calls[0]
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.body, JSON.stringify({ bibcode: ['2020ApJ...900..123A'] }))
  assert.equal(call.init.headers['Content-Type'], 'application/json')
  assert.equal(call.init.headers['X-Custom'], '1')
  assert.equal(call.init.headers.Authorization, 'Bearer real-token')
  client.dispose()
})

test('caller authorization headers (any case) never ride alongside the stored token', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, {}), clock)
  const client = createApiClient(makeCtx({ token: 'real-token' }), TEST_CONFIG, { fetch, clock })
  await client.request('/search/query', { headers: { authorization: 'Bearer attacker', AUTHORIZATION: 'Bearer attacker2' } })
  const headers = fetch.calls[0].init.headers
  assert.equal(headers.Authorization, 'Bearer real-token')
  assert.equal(Object.keys(headers).filter(k => k.toLowerCase() === 'authorization').length, 1)
  client.dispose()
})

test('TOKEN_MISSING: actionable ScixError, no fetch, exact contract message', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, {}), clock)
  const client = createApiClient(makeCtx({ token: undefined }), TEST_CONFIG, { fetch, clock })
  const err = await expectScix(client.request('/search/query'), ERROR_CODES.TOKEN_MISSING)
  assert.equal(err.message, TOKEN_MISSING_MESSAGE)
  assert.match(err.message, /Plugins → SciX → Configure/)
  assert.equal(fetch.calls.length, 0)
  client.dispose()
})

test('API_ERROR: non-2xx carries status and the API message excerpt', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(400, { message: 'Invalid query syntax' }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const err = await expectScix(client.request('/search/query'), ERROR_CODES.API_ERROR)
  assert.equal(err.status, 400)
  assert.match(err.message, /HTTP 400/)
  assert.match(err.message, /Invalid query syntax/)
  client.dispose()
})

test('invalid JSON on 2xx → API_ERROR with cause', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => new Response('<html>not json</html>', { status: 200 }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const err = await expectScix(client.request('/search/query'), ERROR_CODES.API_ERROR)
  assert.equal(err.status, 200)
  assert.ok(err.cause instanceof SyntaxError)
  client.dispose()
})

test('429 backoff: exponential waits 1000ms then 2000ms, then success', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(i => (i < 2 ? jsonResponse(429, { message: 'rate limited' }) : jsonResponse(200, { ok: true })), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promise = client.request('/search/query')
  await flush()
  assert.equal(fetch.calls.length, 1)
  clock.advance(1000)
  await flush()
  assert.equal(fetch.calls.length, 2)
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 1000])
  clock.advance(2000)
  await flush()
  assert.deepEqual(await promise, { ok: true })
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 1000, 3000])
  client.dispose()
})

test('429 Retry-After is an authoritative floor (3s beats the 1s base)', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(i => (i === 0 ? jsonResponse(429, {}, { 'Retry-After': '3' }) : jsonResponse(200, { ok: true })), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promise = client.request('/search/query')
  await flush()
  clock.advance(2999)
  await flush()
  assert.equal(fetch.calls.length, 1)
  clock.advance(1)
  await flush()
  assert.deepEqual(await promise, { ok: true })
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 3000])
  client.dispose()
})

test('429 X-RateLimit-Reset (unix seconds) is honored', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(i => (i === 0
    ? jsonResponse(429, {}, { 'X-RateLimit-Reset': '5', 'X-RateLimit-Remaining': '0' })
    : jsonResponse(200, { ok: true })), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promise = client.request('/search/query')
  await flush()
  clock.advance(5000)
  await flush()
  assert.deepEqual(await promise, { ok: true })
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 5000])
  client.dispose()
})

test('429 max retries: 6 sends total, then RATE_LIMITED with status + retryAfterMs', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(429, {}), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  // Attach the rejection handler IMMEDIATELY (the promise rejects mid-loop below).
  const assertion = expectScix(client.request('/search/query'), ERROR_CODES.RATE_LIMITED)
  await flush()
  for (const wait of [1000, 2000, 4000, 8000, 16000]) {
    clock.advance(wait)
    await flush()
  }
  const err = await assertion
  assert.equal(err.status, 429)
  assert.equal(err.retryAfterMs, 32000) // next exponential step advertised to the caller
  assert.equal(fetch.calls.length, 6) // 1 initial + MAX_429_RETRIES(5)
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 1000, 3000, 7000, 15000, 31000])
  client.dispose()
})

test('daily quota: exhausts at the limit with reset-time message; resets at midnight UTC', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, { ok: true }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock, quotaLimit: 3 })
  for (let i = 0; i < 3; i++) await client.request('/search/query')
  const err = await expectScix(client.request('/search/query'), ERROR_CODES.QUOTA_EXCEEDED)
  assert.equal(err.retryAfterMs, 86400000) // clock 0 → next midnight UTC = one day
  assert.match(err.message, /midnight UTC/)
  assert.match(err.message, /1970-01-02T00:00:00\.000Z/)
  assert.equal(fetch.calls.length, 3) // denied request was NOT sent
  clock.advance(86400000)
  await client.request('/search/query') // rollover grants again
  assert.equal(fetch.calls.length, 4)
  client.dispose()
})

test('X-RateLimit headers are authoritative per endpoint (remaining 0 blocks that endpoint only)', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, { ok: true }, {
    'X-RateLimit-Limit': '5000', 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '10',
  }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  await client.request('/search/query')
  const err = await expectScix(client.request('/search/query'), ERROR_CODES.QUOTA_EXCEEDED)
  assert.equal(err.retryAfterMs, 10000)
  assert.match(err.message, /search/)
  assert.equal(fetch.calls.length, 1)
  await client.request('/export/bibtex', { method: 'POST', body: { bibcode: ['x'] } }) // other endpoint unaffected
  assert.equal(fetch.calls.length, 2)
  clock.advance(10000)
  await client.request('/search/query') // reset passed
  assert.equal(fetch.calls.length, 3)
  client.dispose()
})

test('abort: pre-aborted signal rejects ABORTED without sending', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, {}), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const controller = new AbortController()
  controller.abort()
  await expectScix(client.request('/search/query', { signal: controller.signal }), ERROR_CODES.ABORTED)
  assert.equal(fetch.calls.length, 0)
  client.dispose()
})

test('abort: in-flight fetch aborts → ABORTED', async () => {
  const clock = createVirtualClock(0)
  const fetch = hangingFetch(clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const controller = new AbortController()
  const promise = client.request('/search/query', { signal: controller.signal })
  await flush()
  assert.equal(fetch.calls.length, 1)
  controller.abort()
  await expectScix(promise, ERROR_CODES.ABORTED)
  client.dispose()
})

test('dispose: cancels in-flight AND queued work, no pending timers, idempotent, later calls ABORTED', async () => {
  const clock = createVirtualClock(0)
  const fetch = hangingFetch(clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promises = Array.from({ length: 20 }, () => client.request('/search/query'))
  const settled = promises.map(p => p.then(() => 'resolved', err => err))
  await flush()
  assert.equal(fetch.calls.length, 15) // burst granted
  assert.equal(clock.pending, 1) // FIFO waiter timer for request #16
  client.dispose()
  client.dispose() // idempotent
  const outcomes = await Promise.all(settled)
  for (const err of outcomes) {
    assert.ok(err instanceof ScixError)
    assert.equal(err.code, ERROR_CODES.ABORTED)
  }
  assert.equal(clock.pending, 0) // no dangling timers
  for (const call of fetch.calls) assert.equal(call.init.signal.aborted, true) // no dangling requests
  await expectScix(client.request('/search/query'), ERROR_CODES.ABORTED)
  await expectScix(client.requestExternal('https://arxiv.org/html/2401.00001'), ERROR_CODES.ABORTED)
  assert.equal(fetch.calls.length, 15) // nothing new sent after dispose
})

test('token resolved at SEND time: rotated credential applies to the retry without restart', async () => {
  const clock = createVirtualClock(0)
  let n = 0
  const ctx = makeCtx({ resolveImpl: () => ({ value: `tok-${++n}`, source: 'user-env' }) })
  const fetch = stubFetch(i => (i === 0 ? jsonResponse(429, {}) : jsonResponse(200, { ok: true })), clock)
  const client = createApiClient(ctx, TEST_CONFIG, { fetch, clock })
  const promise = client.request('/search/query')
  await flush()
  clock.advance(1000)
  await flush()
  await promise
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer tok-1')
  assert.equal(fetch.calls[1].init.headers.Authorization, 'Bearer tok-2')
  client.dispose()
})

test('PDF guard: ADS path containing /pdf/ is refused before any send', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, {}), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const err = await expectScix(client.request('/link_gateway/2020ApJ.../pdf'), ERROR_CODES.API_ERROR)
  assert.match(err.message, /PDF/)
  assert.equal(fetch.calls.length, 0)
  client.dispose()
})
