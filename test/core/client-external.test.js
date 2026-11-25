/**
 * requestExternal: per-host spacing, NO Authorization, NO ADS quota
 * consumption, raw non-2xx resolution, bounded 429/503 retries with
 * Retry-After, abort/dispose, PDF guards (URL, redirect target, content-type).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { flush, makeCtx, jsonResponse, rawResponse, stubFetch, hangingFetch, TEST_CONFIG } from './helpers.mjs'

register('./dsh-stubs.mjs', import.meta.url)
const { createApiClient } = await import('../../src/core/client.js')
const { ScixError } = await import('../../src/core/errors.js')
const { createVirtualClock } = await import('../../src/core/queue.js')
const { ERROR_CODES } = await import('../../src/contracts/errors.js')

async function expectScix(promise, code) {
  try {
    await promise
  } catch (err) {
    assert.ok(err instanceof ScixError, `expected ScixError, got ${err?.name}: ${err?.message}`)
    assert.equal(err.code, code)
    return err
  }
  assert.fail(`expected ScixError(${code}) but the promise resolved`)
}

const html = (text = '<html><body>paper</body></html>') => rawResponse({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, text })

test('arXiv lane: ≥1000ms between starts; arxiv.org and ar5iv SHARE the lane', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => html(), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const urls = [
    'https://arxiv.org/html/2401.00001v1',
    'https://ar5iv.labs.arxiv.org/html/2401.00002',
    'https://arxiv.org/html/2401.00003v2',
  ]
  const promises = urls.map(url => client.requestExternal(url, { accept: 'text/html' }))
  await flush()
  assert.equal(fetch.calls.length, 1)
  clock.advance(1000)
  await flush()
  assert.equal(fetch.calls.length, 2)
  clock.advance(1000)
  await flush()
  const results = await Promise.all(promises)
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 1000, 2000])
  for (const result of results) {
    assert.equal(result.status, 200)
    assert.equal(result.text, '<html><body>paper</body></html>')
    assert.equal(result.headers['content-type'], 'text/html; charset=utf-8')
  }
  assert.equal(fetch.calls[0].init.headers.Accept, 'text/html')
  client.dispose()
})

test('Semantic Scholar has its OWN lane (parallel with arXiv at t=0)', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, { data: [] }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promises = [
    client.requestExternal('https://api.semanticscholar.org/graph/v1/paper/ARXIV:2401.00001/citations?fields=intents'),
    client.requestExternal('https://arxiv.org/html/2401.00001v1'),
    client.requestExternal('https://api.semanticscholar.org/graph/v1/paper/DOI:10.1234/x/citations'),
  ]
  await flush()
  assert.equal(fetch.calls.length, 2) // s2 #1 + arxiv #1 at t=0; s2 #2 waits its own lane
  clock.advance(1000)
  await flush()
  await Promise.all(promises)
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 0, 1000])
  client.dispose()
})

test('NO Authorization header ever; caller Authorization stripped; other headers kept', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, {}), clock)
  const client = createApiClient(makeCtx({ token: 'super-secret' }), TEST_CONFIG, { fetch, clock })
  await client.requestExternal('https://api.semanticscholar.org/graph/v1/paper/ARXIV:1/citations', {
    headers: { Authorization: 'Bearer super-secret', authorization: 'Bearer lower', 'X-Api-Key': 'user-s2-key' },
  })
  const headers = fetch.calls[0].init.headers
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers.authorization, undefined)
  assert.equal(Object.keys(headers).some(k => k.toLowerCase() === 'authorization'), false)
  assert.equal(headers['X-Api-Key'], 'user-s2-key')
  assert.equal(headers.Accept, 'application/json') // default accept
  client.dispose()
})

test('external calls do NOT consume the ADS daily quota', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(200, {}), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock, quotaLimit: 2, externalMinIntervalMs: 0 })
  for (let i = 0; i < 5; i++) {
    await client.requestExternal(`https://api.semanticscholar.org/graph/v1/paper/ARXIV:${i}/citations`)
  }
  await client.request('/search/query') // ADS slot 1
  await client.request('/search/query') // ADS slot 2
  const err = await expectScix(client.request('/search/query'), ERROR_CODES.QUOTA_EXCEEDED)
  assert.equal(err.retryAfterMs, 86400000)
  assert.equal(fetch.calls.length, 7) // 5 external + 2 ADS; third ADS denied
  client.dispose()
})

test('raw non-2xx RESOLVES (404 arXiv HTML) so callers can degrade honestly', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => rawResponse({ status: 404, headers: { 'content-type': 'text/html' }, text: '<html>no rendering</html>' }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const result = await client.requestExternal('https://arxiv.org/html/1234.56789v1')
  assert.equal(result.status, 404)
  assert.equal(result.text, '<html>no rendering</html>')
  assert.equal(fetch.calls.length, 1) // 404 is NOT retried
  client.dispose()
})

test('S2 429: ≤2 retries with backoff honoring Retry-After, then resolves the raw 429', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => jsonResponse(429, { message: 'too many' }, { 'Retry-After': '4' }), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promise = client.requestExternal('https://api.semanticscholar.org/graph/v1/paper/ARXIV:1/citations')
  await flush()
  clock.advance(4000) // attempt 0 → wait max(1000, 4000)
  await flush()
  assert.equal(fetch.calls.length, 2)
  clock.advance(4000) // attempt 1 → wait max(2000, 4000)
  await flush()
  const result = await promise
  assert.equal(result.status, 429) // raw status after retry exhaustion
  assert.equal(fetch.calls.length, 3) // 1 + 2 retries
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 4000, 8000])
  client.dispose()
})

test('arXiv 503: retried with exponential backoff, then success', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(i => (i === 0 ? rawResponse({ status: 503, text: 'busy' }) : html()), clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const promise = client.requestExternal('https://ar5iv.labs.arxiv.org/html/2401.00001')
  await flush()
  clock.advance(1000)
  await flush()
  const result = await promise
  assert.equal(result.status, 200)
  assert.deepEqual(fetch.calls.map(c => c.at), [0, 1000])
  client.dispose()
})

test('abort + dispose cancel external work (in-flight and lane-queued), no timers left', async () => {
  const clock = createVirtualClock(0)
  const fetch = hangingFetch(clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  const controller = new AbortController()
  const p1 = client.requestExternal('https://arxiv.org/html/2401.00001v1', { signal: controller.signal })
  const p2 = client.requestExternal('https://arxiv.org/html/2401.00002v1') // queued in the lane
  const s1 = p1.then(() => 'resolved', err => err)
  const s2 = p2.then(() => 'resolved', err => err)
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.equal(clock.pending, 1)
  controller.abort()
  const err1 = await s1
  assert.equal(err1.code, ERROR_CODES.ABORTED)
  client.dispose()
  const err2 = await s2
  assert.equal(err2.code, ERROR_CODES.ABORTED)
  assert.equal(clock.pending, 0)
  for (const call of fetch.calls) assert.equal(call.init.signal.aborted, true)
})

test('PDF guards: /pdf/ URL, .pdf URL, redirect target, application/pdf content-type', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch((i, url) => {
    if (url.includes('redirect-to-pdf')) {
      return rawResponse({ status: 200, url: 'https://arxiv.org/pdf/2401.00001v1', headers: { 'content-type': 'text/html' }, text: 'pdf bytes' })
    }
    if (url.includes('pdf-content-type')) {
      return rawResponse({ status: 200, headers: { 'content-type': 'application/pdf' }, text: '%PDF-1.4' })
    }
    return html()
  }, clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock, externalMinIntervalMs: 0 })
  await expectScix(client.requestExternal('https://arxiv.org/pdf/2401.00001v1'), ERROR_CODES.API_ERROR)
  await expectScix(client.requestExternal('https://arxiv.org/abs/2401.00001.pdf'), ERROR_CODES.API_ERROR)
  assert.equal(fetch.calls.length, 0) // refused before any send
  const err3 = await expectScix(client.requestExternal('https://arxiv.org/redirect-to-pdf/2401.00001'), ERROR_CODES.API_ERROR)
  assert.match(err3.message, /PDF/)
  const err4 = await expectScix(client.requestExternal('https://arxiv.org/pdf-content-type/2401.00001'), ERROR_CODES.API_ERROR)
  assert.match(err4.message, /PDF/)
  client.dispose()
})

test('invalid URL / non-http scheme → API_ERROR; transport failure → API_ERROR with cause', async () => {
  const clock = createVirtualClock(0)
  const fetch = stubFetch(() => { throw new TypeError('fetch failed') }, clock)
  const client = createApiClient(makeCtx(), TEST_CONFIG, { fetch, clock })
  await expectScix(client.requestExternal('not a url'), ERROR_CODES.API_ERROR)
  await expectScix(client.requestExternal('ftp://arxiv.org/html/1'), ERROR_CODES.API_ERROR)
  const err = await expectScix(client.requestExternal('https://arxiv.org/html/2401.00001v1'), ERROR_CODES.API_ERROR)
  assert.ok(err.cause instanceof TypeError)
  assert.match(err.message, /arxiv\.org/)
  client.dispose()
})
