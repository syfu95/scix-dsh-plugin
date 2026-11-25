/**
 * Pure queue/backoff/quota math (src/core/queue.js) — dependency-free, so
 * this file imports it statically; no DSH stubs needed. Virtual clock only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MS_PER_DAY,
  createVirtualClock,
  createRealClock,
  createBurstGate,
  createHostLane,
  createDailyQuota,
  utcDayIndex,
  nextUtcMidnightMs,
  parseRetryAfterMs,
  parseRateLimitResetMs,
  computeBackoffMs,
} from '../../src/core/queue.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

test('burst gate: first 15 grants immediate, 16th-20th wait for the rolling window', async () => {
  const clock = createVirtualClock(0)
  const gate = createBurstGate({ limit: 15, clock })
  const grantedAt = []
  const acquires = Array.from({ length: 20 }, () => gate.acquire().then(() => { grantedAt.push(clock.now()) }))
  await flush()
  assert.equal(grantedAt.length, 15)
  assert.deepEqual(grantedAt, Array(15).fill(0))
  assert.equal(clock.pending, 1) // one shared wait timer for the next in line
  clock.advance(999)
  await flush()
  assert.equal(grantedAt.length, 15) // not yet: window is 1000ms
  clock.advance(1)
  await flush()
  await Promise.all(acquires)
  assert.equal(grantedAt.length, 20)
  assert.deepEqual(grantedAt.slice(15), [1000, 1000, 1000, 1000, 1000])
  assert.equal(clock.pending, 0)
})

test('burst gate: FIFO order preserved under synchronous concurrency', async () => {
  const clock = createVirtualClock(0)
  const gate = createBurstGate({ limit: 2, windowMs: 1000, clock })
  const order = []
  const acquires = Array.from({ length: 6 }, (_, i) => gate.acquire().then(() => { order.push(i) }))
  await flush()
  clock.advance(1000)
  await flush()
  clock.advance(1000)
  await flush()
  await Promise.all(acquires)
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5])
})

test('burst gate: aborted waiter rejects without breaking the chain', async () => {
  const clock = createVirtualClock(0)
  const gate = createBurstGate({ limit: 1, windowMs: 1000, clock })
  const controller = new AbortController()
  const first = gate.acquire()
  const aborted = gate.acquire(controller.signal)
  const third = gate.acquire()
  await flush()
  controller.abort()
  await assert.rejects(aborted, err => err.name === 'AbortError')
  clock.advance(1000)
  await flush()
  await Promise.all([first, third]) // chain survived the abort
  assert.equal(clock.pending, 0)
})

test('host lane: ≥1000ms between grant times, FIFO', async () => {
  const clock = createVirtualClock(500)
  const lane = createHostLane({ minIntervalMs: 1000, clock })
  const grantedAt = []
  const acquires = Array.from({ length: 3 }, () => lane.acquire().then(() => { grantedAt.push(clock.now()) }))
  await flush()
  assert.deepEqual(grantedAt, [500])
  clock.advance(1000)
  await flush()
  assert.deepEqual(grantedAt, [500, 1500])
  clock.advance(1000)
  await flush()
  await Promise.all(acquires)
  assert.deepEqual(grantedAt, [500, 1500, 2500])
})

test('daily quota: exhausts at the limit, reports ms until midnight UTC', () => {
  const clock = createVirtualClock(Date.UTC(2026, 10, 25, 23, 0, 0))
  const quota = createDailyQuota({ limit: 3, clock })
  assert.deepEqual(quota.tryConsume(), { ok: true, remaining: 2 })
  assert.deepEqual(quota.tryConsume(), { ok: true, remaining: 1 })
  assert.deepEqual(quota.tryConsume(), { ok: true, remaining: 0 })
  const denied = quota.tryConsume()
  assert.equal(denied.ok, false)
  assert.equal(denied.resetAtMs, Date.UTC(2026, 10, 26))
  assert.equal(denied.retryAfterMs, 60 * 60 * 1000) // 23:00 → midnight = 1h
  assert.equal(quota.snapshot().used, 3)
})

test('daily quota: sequential-safe — exactly limit grants for limit+K concurrent callers', () => {
  const clock = createVirtualClock(0)
  const quota = createDailyQuota({ limit: 100, clock })
  let granted = 0
  for (let i = 0; i < 150; i++) if (quota.tryConsume().ok) granted++
  assert.equal(granted, 100)
})

test('daily quota: resets exactly at midnight UTC rollover', () => {
  const clock = createVirtualClock(MS_PER_DAY - 1) // 23:59:59.999 of day 0
  const quota = createDailyQuota({ limit: 1, clock })
  assert.equal(quota.tryConsume().ok, true)
  assert.equal(quota.tryConsume().ok, false)
  clock.advance(1) // exactly day 1, 00:00:00.000 UTC
  assert.equal(quota.snapshot().used, 0)
  assert.equal(quota.tryConsume().ok, true)
})

test('UTC math: day index and next midnight', () => {
  const now = Date.UTC(2026, 10, 25, 21, 17, 49)
  assert.equal(utcDayIndex(now), Math.floor(now / MS_PER_DAY))
  assert.equal(nextUtcMidnightMs(now), Date.UTC(2026, 10, 26))
  assert.equal(nextUtcMidnightMs(Date.UTC(2026, 10, 26)), Date.UTC(2026, 10, 27))
})

test('parseRetryAfterMs: delay-seconds, HTTP-date, invalid', () => {
  const now = Date.UTC(2026, 10, 25, 12, 0, 0)
  assert.equal(parseRetryAfterMs('120', now), 120000)
  assert.equal(parseRetryAfterMs(' 3 ', now), 3000)
  assert.equal(parseRetryAfterMs('Wed, 25 Nov 2026 12:02:00 GMT', now), 120000)
  assert.equal(parseRetryAfterMs('Wed, 25 Nov 2026 11:59:00 GMT', now), 0) // past date clamps to 0
  assert.equal(parseRetryAfterMs('soon', now), undefined)
  assert.equal(parseRetryAfterMs('', now), undefined)
  assert.equal(parseRetryAfterMs(null, now), undefined)
  assert.equal(parseRetryAfterMs(undefined, now), undefined)
})

test('parseRateLimitResetMs: unix seconds → epoch ms', () => {
  assert.equal(parseRateLimitResetMs('1700000000'), 1700000000000)
  assert.equal(parseRateLimitResetMs('0'), 0)
  assert.equal(parseRateLimitResetMs('abc'), undefined)
  assert.equal(parseRateLimitResetMs('-5'), undefined)
  assert.equal(parseRateLimitResetMs(null), undefined)
})

test('computeBackoffMs: exponential doubling with cap', () => {
  const args = { baseMs: 1000, maxMs: 60000 }
  assert.equal(computeBackoffMs({ ...args, attempt: 0 }), 1000)
  assert.equal(computeBackoffMs({ ...args, attempt: 1 }), 2000)
  assert.equal(computeBackoffMs({ ...args, attempt: 2 }), 4000)
  assert.equal(computeBackoffMs({ ...args, attempt: 5 }), 32000)
  assert.equal(computeBackoffMs({ ...args, attempt: 6 }), 60000) // capped
  assert.equal(computeBackoffMs({ ...args, attempt: 10 }), 60000)
})

test('computeBackoffMs: Retry-After and reset are authoritative floors (uncapped)', () => {
  const base = { attempt: 0, baseMs: 1000, maxMs: 60000 }
  assert.equal(computeBackoffMs({ ...base, retryAfterMs: 3000 }), 3000)
  assert.equal(computeBackoffMs({ ...base, retryAfterMs: 500 }), 1000) // exponential wins when larger
  assert.equal(computeBackoffMs({ ...base, retryAfterMs: 120000 }), 120000) // server beats the cap
  assert.equal(computeBackoffMs({ ...base, resetMs: 5000, nowMs: 0 }), 5000)
  assert.equal(computeBackoffMs({ ...base, resetMs: 1000, nowMs: 500 }), 1000)
  assert.equal(computeBackoffMs({ ...base, retryAfterMs: 2000, resetMs: 9000, nowMs: 0 }), 9000)
})

test('virtual clock: timers fire in order; abort removes the pending timer', async () => {
  const clock = createVirtualClock(0)
  const fired = []
  const controller = new AbortController()
  const p1 = clock.delay(100).then(() => { fired.push('a') })
  const p2 = clock.delay(50, controller.signal).then(() => { fired.push('b') })
  const p3 = clock.delay(200).then(() => { fired.push('c') })
  assert.equal(clock.pending, 3)
  controller.abort()
  await assert.rejects(p2, err => err.name === 'AbortError')
  assert.equal(clock.pending, 2)
  clock.advance(200)
  await Promise.all([p1, p3])
  assert.deepEqual(fired, ['a', 'c'])
  assert.equal(clock.pending, 0)
})

test('real clock: delay resolves; abort rejects and leaves no pending work', async () => {
  const clock = createRealClock()
  const started = Date.now()
  await clock.delay(5)
  assert.ok(Date.now() - started >= 4)
  const controller = new AbortController()
  const pending = clock.delay(60000, controller.signal)
  controller.abort()
  await assert.rejects(pending, err => err.name === 'AbortError')
  // pre-aborted signal rejects immediately
  await assert.rejects(clock.delay(10, controller.signal), err => err.name === 'AbortError')
})
