/**
 * working-set store tests: add/set/list/exclude/get/dispose per
 * src/contracts/working-set.js, session isolation, defensive copies.
 * Pure module — no DSH imports needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkingSetStore } from '../../src/tools/working-set.js'
import { DEFAULT_WORKING_SET_ID } from '../../src/contracts/working-set.js'
import { sessionKeyFromExec, FALLBACK_SESSION_KEY } from '../../src/tools/session.js'

const paper = (bibcode, extra = {}) => ({ bibcode, ...extra })

test('add auto-creates the session default set and dedupes by verbatim bibcode', () => {
  const store = createWorkingSetStore()
  const first = store.add('s1', [paper('2021arXiv210301234X', { title: 'A', year: 2021 }), paper('2020ApJ...890..123D')])
  assert.equal(first.working_set_id, DEFAULT_WORKING_SET_ID)
  assert.deepEqual(first.added, ['2021arXiv210301234X', '2020ApJ...890..123D'])
  assert.equal(first.size, 2)
  const second = store.add('s1', [paper('2021arXiv210301234X'), paper('2019arXiv190101234S')])
  assert.deepEqual(second.added, ['2019arXiv190101234S'])
  assert.equal(second.size, 3)
})

test('sessions never leak into each other', () => {
  const store = createWorkingSetStore()
  store.add('s1', [paper('2021arXiv210301234X')])
  store.add('s2', [paper('2020ApJ...890..123D')])
  assert.equal(store.get('s1').size, 1)
  assert.equal(store.get('s2').size, 1)
  assert.deepEqual(store.list('s1'), [{ working_set_id: DEFAULT_WORKING_SET_ID, size: 1, excluded_count: 0 }])
  assert.deepEqual(store.list('s3'), [])
  assert.equal(store.get('s3'), undefined)
})

test('exclude moves members out, reports only newly excluded, and blocks re-add', () => {
  const store = createWorkingSetStore()
  store.add('s1', [paper('A'), paper('B'), paper('C')])
  const res = store.exclude('s1', ['B', 'B', 'X'])
  assert.deepEqual(res.excluded, ['B', 'X'])
  assert.equal(res.size, 2)
  const snap = store.get('s1')
  assert.deepEqual(snap.papers.map((p) => p.bibcode), ['A', 'C'])
  assert.deepEqual(snap.excluded.sort(), ['B', 'X'])
  // Sticky exclusion: search auto-add must not resurrect excluded papers.
  const reAdd = store.add('s1', [paper('B'), paper('D')])
  assert.deepEqual(reAdd.added, ['D'])
  const again = store.exclude('s1', ['B'])
  assert.deepEqual(again.excluded, [])
})

test('set replaces membership, creates explicit new sets, clears exclusions for replaced members', () => {
  const store = createWorkingSetStore()
  store.add('s1', [paper('A'), paper('B')])
  store.exclude('s1', ['B', 'Z'])
  const replaced = store.set('s1', [paper('B'), paper('C')])
  assert.equal(replaced.working_set_id, DEFAULT_WORKING_SET_ID)
  assert.equal(replaced.size, 2)
  const snap = store.get('s1')
  assert.deepEqual(snap.papers.map((p) => p.bibcode), ['B', 'C'])
  assert.deepEqual(snap.excluded, ['Z']) // B's exclusion cleared; Z kept
  const custom = store.set('s1', [paper('Q')], 'ws-custom')
  assert.equal(custom.working_set_id, 'ws-custom')
  assert.equal(store.get('s1', 'ws-custom').size, 1)
  assert.equal(store.get('s1').size, 2) // default untouched
  assert.equal(store.list('s1').length, 2)
})

test('get/list return defensive copies; invalid entries are dropped', () => {
  const store = createWorkingSetStore()
  store.add('s1', [paper('A', { author: ['Smith, Jane'], year: 2021 }), { title: 'no bibcode' }, null])
  const snap = store.get('s1')
  assert.equal(snap.size, 1)
  snap.papers[0].bibcode = 'HACKED'
  snap.papers.push(paper('INJECTED'))
  snap.excluded.push('INJECTED')
  const fresh = store.get('s1')
  assert.equal(fresh.papers[0].bibcode, 'A')
  assert.equal(fresh.papers.length, 1)
  assert.deepEqual(fresh.excluded, [])
  const summaries = store.list('s1')
  summaries[0].size = 999
  assert.equal(store.list('s1')[0].size, 1)
})

test('dispose clears all sessions and is idempotent', () => {
  const store = createWorkingSetStore()
  store.add('s1', [paper('A')])
  store.add('s2', [paper('B')])
  store.dispose()
  store.dispose()
  assert.deepEqual(store.list('s1'), [])
  assert.equal(store.get('s2'), undefined)
})

test('sessionKeyFromExec uses exec.agent.id (verified SessionId) with documented fallback', () => {
  assert.equal(sessionKeyFromExec({ agent: { id: 'session-abc' } }), 'session-abc')
  assert.equal(sessionKeyFromExec({ agent: { id: '' } }), FALLBACK_SESSION_KEY)
  assert.equal(sessionKeyFromExec({}), FALLBACK_SESSION_KEY)
  assert.equal(sessionKeyFromExec(undefined), FALLBACK_SESSION_KEY)
})
