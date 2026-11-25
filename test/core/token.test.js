/**
 * Token helpers + verify Remote registration. globalThis.fetch is stubbed
 * (node:test mock, auto-restored); ctx.credentials / ctx.provide are fakes.
 * The typert-protocol stub is faithful to installed source (see stubs/).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { makeCtx, jsonResponse } from './helpers.mjs'

register('./dsh-stubs.mjs', import.meta.url)
const { getToken, setToken, unsetToken, verifyToken, registerVerifyRemote } = await import('../../src/core/token.js')
const { ScixError } = await import('../../src/core/errors.js')
const { remoteMethods } = await import('./stubs/dsh-typert-protocol.mjs')
const { ERROR_CODES, TOKEN_MISSING_MESSAGE } = await import('../../src/contracts/errors.js')
const { TOKEN_CREDENTIAL_REF, REMOTE_SERVICE_NAME, REMOTE_NAMESPACE, REMOTE_VERIFY_METHOD } = await import('../../src/contracts/token.js')
const { CONFIG_DEFAULTS } = await import('../../src/contracts/config.js')

const PROBE_PATH = '/search/query?q=*:*&rows=1&fl=id'

test('getToken: resolves the canonical ref; absent/empty → undefined', async () => {
  const ctx = makeCtx({ token: 'tok-1' })
  assert.equal(await getToken(ctx), 'tok-1')
  assert.deepEqual(ctx.calls.resolve, [TOKEN_CREDENTIAL_REF])
  assert.equal(TOKEN_CREDENTIAL_REF, 'SCIX_API_TOKEN')
  assert.equal(await getToken(makeCtx({ token: undefined })), undefined)
  assert.equal(await getToken(makeCtx({ resolveImpl: () => ({ value: '', source: 'file' }) })), undefined)
})

test('setToken: trims and stores under the ref; empty/whitespace rejected actionably', async () => {
  const ctx = makeCtx()
  await setToken(ctx, '  tok-2\n')
  assert.deepEqual(ctx.calls.set, [[TOKEN_CREDENTIAL_REF, 'tok-2']])
  for (const bad of ['', '   ', undefined, 42]) {
    await assert.rejects(setToken(ctx, bad), err => err instanceof ScixError && err.code === ERROR_CODES.API_ERROR && /empty ADS token/.test(err.message))
  }
  assert.equal(ctx.calls.set.length, 1) // rejected values never stored
})

test('unsetToken: delegates to credentials.unset (no-op when absent)', async () => {
  const ctx = makeCtx()
  await unsetToken(ctx)
  assert.deepEqual(ctx.calls.unset, [TOKEN_CREDENTIAL_REF])
})

test('verifyToken ok: exact lightweight probe, Bearer auth, never echoes the token', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, init })
    return jsonResponse(200, { response: { docs: [{ id: '2020ApJ...900..123A' }] } })
  })
  const result = await verifyToken(makeCtx({ token: 'secret-tok' }))
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.match(result.message, /api\.adsabs\.harvard\.edu/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, CONFIG_DEFAULTS.apiBaseUrl + PROBE_PATH)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-tok')
  assert.equal(JSON.stringify(result).includes('secret-tok'), false)
})

test('verifyToken 401: ok:false with status + actionable token-page message', async t => {
  t.mock.method(globalThis, 'fetch', async () => jsonResponse(401, { message: 'Missing "Authorization" in headers.' }))
  const result = await verifyToken(makeCtx({ token: 'bad-tok' }))
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.match(result.message, /401/)
  assert.match(result.message, /ui\.adsabs\.harvard\.edu\/user\/settings\/token/)
  assert.equal(result.message.includes('bad-tok'), false)
})

test('verifyToken 403 / 429 / 500: ok:false with the probe status', async t => {
  for (const status of [403, 429, 500]) {
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(status, {}))
    const result = await verifyToken(makeCtx())
    assert.equal(result.ok, false)
    assert.equal(result.status, status)
    assert.ok(result.message.length > 0)
    t.mock.restoreAll()
  }
})

test('verifyToken network failure: RESOLVES ok:false without status (renderable message)', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed') })
  const result = await verifyToken(makeCtx())
  assert.equal(result.ok, false)
  assert.equal(result.status, undefined)
  assert.match(result.message, /Could not reach the ADS API/)
  assert.match(result.message, /apiBaseUrl/)
})

test('verifyToken missing token: ok:false with the exact contract message, no probe sent', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => jsonResponse(200, {}))
  const result = await verifyToken(makeCtx({ token: undefined }))
  assert.deepEqual(result, { ok: false, message: TOKEN_MISSING_MESSAGE })
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('verifyToken honors options.apiBaseUrl (SciX host)', async t => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return jsonResponse(200, {}) })
  const result = await verifyToken(makeCtx(), { apiBaseUrl: 'https://api.scixplorer.org/v1/' })
  assert.equal(result.ok, true)
  assert.equal(calls[0], 'https://api.scixplorer.org/v1' + PROBE_PATH)
})

test('verifyToken abort: pre-aborted and mid-flight both throw ScixError(ABORTED)', async t => {
  t.mock.method(globalThis, 'fetch', (url, init) => new Promise((resolve, reject) => {
    const onAbort = () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError'))
    if (init.signal.aborted) { onAbort(); return }
    init.signal.addEventListener('abort', onAbort, { once: true })
  }))
  const pre = new AbortController()
  pre.abort()
  await assert.rejects(verifyToken(makeCtx(), { signal: pre.signal }), err => err instanceof ScixError && err.code === ERROR_CODES.ABORTED)
  const mid = new AbortController()
  const promise = verifyToken(makeCtx(), { signal: mid.signal })
  await new Promise(resolve => setImmediate(resolve))
  mid.abort()
  await assert.rejects(promise, err => err instanceof ScixError && err.code === ERROR_CODES.ABORTED)
})

test('registerVerifyRemote: live service + binding + prototype marker; zero-arg method delegates with configured base', async t => {
  const provided = []
  let disposed = false
  const ctx = {
    ...makeCtx({ token: 'remote-tok' }),
    provide(name, value) {
      provided.push({ name, value })
      return () => { disposed = true }
    },
  }
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return jsonResponse(200, {}) })

  const disposer = registerVerifyRemote(ctx, { apiBaseUrl: 'https://api.scixplorer.org/v1' })
  assert.equal(provided.length, 1)
  assert.equal(provided[0].name, REMOTE_SERVICE_NAME)
  assert.equal(REMOTE_SERVICE_NAME, 'scixController')
  const service = provided[0].value

  // Gateway SRC discovery state (collectSrcClaims/readBinding/remoteMethods):
  const binding = service.typertRemote
  assert.equal(binding.service, service)
  assert.equal(binding.serviceKey, REMOTE_SERVICE_NAME)
  assert.equal(binding.namespace, REMOTE_NAMESPACE)
  assert.equal(REMOTE_NAMESPACE, 'scix')
  assert.ok(Object.isFrozen(binding))
  const markers = remoteMethods(service)
  assert.deepEqual(markers, [{ method: REMOTE_VERIFY_METHOD, invocation: { kind: 'direct' } }])
  assert.equal(REMOTE_VERIFY_METHOD, 'verifyToken')
  assert.equal(service[REMOTE_VERIFY_METHOD].length, 0) // zero wire args

  // The endpoint method delegates to verifyToken with the CONFIGURED base.
  const result = await service[REMOTE_VERIFY_METHOD]()
  assert.equal(result.ok, true)
  assert.equal(calls[0], 'https://api.scixplorer.org/v1' + PROBE_PATH)

  // Disposer is the ctx.provide disposer.
  assert.equal(typeof disposer, 'function')
  disposer()
  assert.equal(disposed, true)
})

test('registerVerifyRemote: defaults to CONFIG_DEFAULTS.apiBaseUrl without config', async t => {
  let service
  const ctx = {
    ...makeCtx(),
    provide(name, value) { service = value; return () => {} },
  }
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => { calls.push(url); return jsonResponse(200, {}) })
  registerVerifyRemote(ctx)
  const result = await service[REMOTE_VERIFY_METHOD]()
  assert.equal(result.ok, true)
  assert.equal(calls[0], CONFIG_DEFAULTS.apiBaseUrl + PROBE_PATH)
})
