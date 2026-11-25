/** S2 intent matching: normalization, key building, verbatim attachment. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDoi, normalizeArxivId, s2PaperKey, buildS2Index, matchS2Intents } from '../../src/tools/intents.js'
import { resolveArxivId } from '../../src/tools/paper-map.js'
import { s2Page, docAtmos, citingMethod, citingBackground, citingEmptyIntents, citingUnmatched } from './fixtures.js'

test('DOI normalization: case + URL prefix (matching only)', () => {
  assert.equal(normalizeDoi('10.3847/1538-4357/ABCD'), '10.3847/1538-4357/abcd')
  assert.equal(normalizeDoi('https://doi.org/10.1051/X'), '10.1051/x')
  assert.equal(normalizeDoi('http://dx.doi.org/10.1051/X'), '10.1051/x')
})

test('arXiv normalization strips version suffix for matching only', () => {
  assert.equal(normalizeArxivId('2105.00001v2'), '2105.00001')
  assert.equal(normalizeArxivId('2103.01234'), '2103.01234')
})

test('s2PaperKey prefers DOI, falls back to arXiv, null when neither', () => {
  assert.equal(s2PaperKey(docAtmos, resolveArxivId), 'DOI:10.1051/0004-6361/202140001')
  assert.equal(s2PaperKey({ identifier: ['arXiv:2103.01234'] }, resolveArxivId), 'ARXIV:2103.01234')
  assert.equal(s2PaperKey({ bibcode: '2020ApJ...890..123D' }, resolveArxivId), null)
})

test('buildS2Index + matchS2Intents: DOI case-insensitive, arXiv version-tolerant, verbatim intents', () => {
  const index = buildS2Index(s2Page)
  const method = matchS2Intents(citingMethod, index, resolveArxivId)
  assert.deepEqual(method.intents, ['method'])
  assert.equal(method.isInfluential, true)
  assert.ok(method.contexts[0].includes('We use the method'))
  const background = matchS2Intents(citingBackground, index, resolveArxivId)
  assert.deepEqual(background.intents, ['background'])
  const empty = matchS2Intents(citingEmptyIntents, index, resolveArxivId)
  assert.deepEqual(empty.intents, []) // matched but unlabeled — distinct from null
  assert.equal(matchS2Intents(citingUnmatched, index, resolveArxivId), null)
})

test('malformed S2 payloads yield an empty index (never throw)', () => {
  assert.equal(buildS2Index(null).size, 0)
  assert.equal(buildS2Index({}).size, 0)
  assert.equal(buildS2Index({ data: [null, {}, { citingPaper: {} }] }).size, 0)
})
