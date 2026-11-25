/** Bibcode/id hygiene + Solr batching helpers. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isBibcode, isValidLibraryId, escapeSolrPhrase, bibcodeOrQuery, chunk,
  BIBCODE_BATCH_SIZE, MAX_DOCUMENT_BATCH,
} from '../../src/tools/bibcode.js'

test('isBibcode accepts real bibcode shapes and rejects breakers', () => {
  assert.ok(isBibcode('2021arXiv210301234X'))
  assert.ok(isBibcode('2020ApJ...890..123D'))
  assert.ok(isBibcode('2001astro.ph..1001S'))
  assert.ok(isBibcode('1999hep.th...1001W'))
  assert.ok(!isBibcode(''))
  assert.ok(!isBibcode('has space'))
  assert.ok(!isBibcode('x"y'))
  assert.ok(!isBibcode('x\\y'))
  assert.ok(!isBibcode('x/y'))
  assert.ok(!isBibcode(42))
  assert.ok(!isBibcode('a'.repeat(65)))
})

test('isValidLibraryId enforces URL-safe base64 shape (path-injection guard)', () => {
  assert.ok(isValidLibraryId('AbC123_-xYz'))
  assert.ok(!isValidLibraryId('../etc'))
  assert.ok(!isValidLibraryId('a/b'))
  assert.ok(!isValidLibraryId('a?b'))
  assert.ok(!isValidLibraryId('a#b'))
  assert.ok(!isValidLibraryId('a.b'))
  assert.ok(!isValidLibraryId(''))
  assert.ok(!isValidLibraryId('a'.repeat(65)))
})

test('escapeSolrPhrase protects quotes/backslashes without touching the stored value', () => {
  assert.equal(escapeSolrPhrase('plain'), 'plain')
  assert.equal(escapeSolrPhrase('say "hi"'), 'say \\"hi\\"')
  assert.equal(escapeSolrPhrase('back\\slash'), 'back\\\\slash')
})

test('bibcodeOrQuery builds a verbatim OR phrase query', () => {
  assert.equal(bibcodeOrQuery(['2021arXiv210301234X', '2020ApJ...890..123D']),
    'bibcode:("2021arXiv210301234X" OR "2020ApJ...890..123D")')
  assert.equal(bibcodeOrQuery(['one']), 'bibcode:("one")')
})

test('chunk splits into bounded batches; constants match documented caps', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 50), [])
  assert.throws(() => chunk([1], 0))
  assert.equal(BIBCODE_BATCH_SIZE, 50)
  assert.equal(MAX_DOCUMENT_BATCH, 2000)
})
