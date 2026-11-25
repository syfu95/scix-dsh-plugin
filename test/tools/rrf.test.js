/** RRF fusion math: fixture ranks, k=60, deterministic ordering, dedupe. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rrfFuse, RRF_K } from '../../src/tools/rrf.js'

test('k constant is 60 (api-brief §3)', () => {
  assert.equal(RRF_K, 60)
})

test('fixture fusion: lexical [A,B,C,D] + similar [C,A,E] → A,C,B,E,D with exact scores', () => {
  const fused = rrfFuse([
    { name: 'lexical', bibcodes: ['A', 'B', 'C', 'D'] },
    { name: 'similar', bibcodes: ['C', 'A', 'E'] },
  ])
  assert.deepEqual(fused.map((f) => f.bibcode), ['A', 'C', 'B', 'E', 'D'])
  const score = (b) => fused.find((f) => f.bibcode === b).score
  assert.ok(Math.abs(score('A') - (1 / 61 + 1 / 62)) < 1e-12)
  assert.ok(Math.abs(score('C') - (1 / 63 + 1 / 61)) < 1e-12)
  assert.ok(Math.abs(score('B') - 1 / 62) < 1e-12)
  assert.ok(Math.abs(score('E') - 1 / 63) < 1e-12)
  assert.ok(Math.abs(score('D') - 1 / 64) < 1e-12)
  assert.deepEqual(fused[0].ranks, { lexical: 1, similar: 2 })
  assert.deepEqual(fused.find((f) => f.bibcode === 'B').ranks, { lexical: 2, similar: null })
  assert.deepEqual(fused.find((f) => f.bibcode === 'E').ranks, { lexical: null, similar: 3 })
})

test('single ranking passes through in rank order (lexical-only degradation)', () => {
  const fused = rrfFuse([{ name: 'lexical', bibcodes: ['X', 'Y'] }, { name: 'similar', bibcodes: [] }])
  assert.deepEqual(fused.map((f) => f.bibcode), ['X', 'Y'])
  assert.equal(fused[0].ranks.similar, null)
})

test('ties break by lexical rank then bibcode asc (deterministic)', () => {
  // Equal fused scores (swapped ranks): lexical rank decides.
  const byLexical = rrfFuse([
    { name: 'lexical', bibcodes: ['A', 'B'] },
    { name: 'similar', bibcodes: ['B', 'A'] },
  ])
  assert.deepEqual(byLexical.map((f) => f.bibcode), ['A', 'B'])
  // Equal scores and no lexical ranks at all: bibcode asc decides.
  const byBibcode = rrfFuse([
    { name: 'a', bibcodes: ['B', 'A'] },
    { name: 'b', bibcodes: ['A', 'B'] },
  ])
  assert.deepEqual(byBibcode.map((f) => f.bibcode), ['A', 'B'])
})

test('duplicate bibcodes within one ranking count once (first rank wins)', () => {
  const fused = rrfFuse([{ name: 'lexical', bibcodes: ['A', 'A', 'B'] }])
  assert.deepEqual(fused.map((f) => f.bibcode), ['A', 'B'])
  assert.equal(fused[0].ranks.lexical, 1)
  assert.ok(Math.abs(fused[0].score - 1 / 61) < 1e-12)
})

test('custom k is honored; empty input yields empty output', () => {
  const fused = rrfFuse([{ name: 'lexical', bibcodes: ['A'] }], 10)
  assert.ok(Math.abs(fused[0].score - 1 / 11) < 1e-12)
  assert.deepEqual(rrfFuse([]), [])
})
