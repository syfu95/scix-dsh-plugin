/** get_paper: broad fl, verbatim identifiers, body signals, uat-400 fallback. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createGetPaperTool } = await import('../../src/tools/get-paper.js')
const { createFakeClient, makeDeps, makeExec, searchResponse, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { validateToolOutput } = await import('./helpers/dsh-stub.js')
const { docAtmos, docNonArxiv, docOldStyle, docArxivNoSignals } = await import('./fixtures.js')
forbidRealNetwork()

test('happy path: full metadata verbatim, body_available estimate, working-set add', async () => {
  const client = createFakeClient({
    request(path, options) {
      assert.equal(path, '/search/query')
      assert.equal(options.params.q, `bibcode:"${docAtmos.bibcode}"`)
      assert.equal(options.params.rows, 1)
      for (const field of ['title', 'author', 'year', 'citation_count', 'abstract', 'doi', 'identifier', 'esources', 'property', 'doctype', 'arxiv_class', 'uat', 'fulltext_mtime']) {
        assert.ok(options.params.fl.split(',').includes(field), `fl missing ${field}`)
      }
      return searchResponse([docAtmos], 1)
    },
  })
  const deps = makeDeps(client)
  const tool = createGetPaperTool(deps)
  const exec = makeExec()
  const result = await tool.execute({ bibcode: docAtmos.bibcode }, exec)
  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.bibcode, docAtmos.bibcode)
  assert.deepEqual(result.doi, docAtmos.doi)
  assert.deepEqual(result.identifier, docAtmos.identifier)
  assert.equal(result.eid, docAtmos.eid)
  assert.equal(result.title, docAtmos.title[0])
  assert.equal(result.year, 2021)
  assert.equal(result.citation_count, 42)
  assert.equal(result.abstract, docAtmos.abstract)
  assert.deepEqual(result.uat, docAtmos.uat)
  assert.equal(result.body_available, true)
  assert.equal(result.arxiv_id, '2103.01234')
  assert.equal(result.arxiv_id_source, 'identifier')
  assert.ok(result.body_available_note.includes('only read_paper confirms'))
  assert.equal(result.working_set_id, 'ws-default')
  assert.equal(deps.workingSets.get('session-test').size, 1)
  assert.equal(client.calls[0].options.signal, exec.signal)
})

test('non-arXiv paper: body_available false with reason; publisher HTML is not a text route', async () => {
  const client = createFakeClient({ request: () => searchResponse([docNonArxiv], 1) })
  const tool = createGetPaperTool(makeDeps(client))
  const result = await tool.execute({ bibcode: docNonArxiv.bibcode }, makeExec())
  assert.equal(result.body_available, false)
  assert.equal(result.arxiv_id, null)
  assert.ok(result.body_available_reason.includes('no arXiv identifier'))
  assert.deepEqual(validateToolOutput(tool, result), [])
})

test('arXiv id without fulltext signals → conservative false; old-style bibcode parsing fallback', async () => {
  const client = createFakeClient({
    request(path, options) {
      return options.params.q.includes(docArxivNoSignals.bibcode)
        ? searchResponse([docArxivNoSignals], 1)
        : searchResponse([docOldStyle], 1)
    },
  })
  const tool = createGetPaperTool(makeDeps(client))
  const noSignals = await tool.execute({ bibcode: docArxivNoSignals.bibcode }, makeExec())
  assert.equal(noSignals.arxiv_id, '1901.01234')
  assert.equal(noSignals.body_available, false)
  const old = await tool.execute({ bibcode: docOldStyle.bibcode }, makeExec())
  assert.equal(old.arxiv_id, 'astro-ph/0101001')
  assert.equal(old.arxiv_id_source, 'bibcode')
  assert.equal(old.body_available, false)
})

test('not found → ScixError API_ERROR with 404 and actionable message', async () => {
  const client = createFakeClient({ request: () => searchResponse([], 0) })
  const tool = createGetPaperTool(makeDeps(client))
  await assert.rejects(tool.execute({ bibcode: '2099XXXXX000000X' }, makeExec()), (error) => {
    assert.equal(error.name, 'ScixError')
    assert.equal(error.code, 'API_ERROR')
    assert.equal(error.status, 404)
    assert.ok(error.message.includes('verbatim'))
    return true
  })
})

test('fl=uat rejected with 400 → one retry without uat + explicit field_note', async () => {
  let calls = 0
  const client = createFakeClient({
    request(path, options) {
      calls += 1
      if (calls === 1) {
        assert.ok(options.params.fl.split(',').includes('uat'))
        throw scixError(ERROR_CODES.API_ERROR, 'unknown field uat', { status: 400 })
      }
      assert.ok(!options.params.fl.split(',').includes('uat'))
      assert.ok(options.params.fl.split(',').includes('keyword_norm'))
      const { uat, ...withoutUat } = docAtmos
      return searchResponse([withoutUat], 1)
    },
  })
  const tool = createGetPaperTool(makeDeps(client))
  const result = await tool.execute({ bibcode: docAtmos.bibcode }, makeExec())
  assert.equal(calls, 2)
  assert.ok(result.field_note.includes('keyword_norm'))
  assert.equal(result.uat, undefined)
  assert.equal(result.body_available, true)
  assert.deepEqual(validateToolOutput(tool, result), [])
})

test('non-400 API errors and TOKEN_MISSING propagate without retry', async () => {
  for (const [code, status] of [[ERROR_CODES.TOKEN_MISSING, undefined], [ERROR_CODES.API_ERROR, 500], [ERROR_CODES.RATE_LIMITED, 429]]) {
    let calls = 0
    const client = createFakeClient({ request: () => { calls += 1; throw scixError(code, 'fail', { status }) } })
    const tool = createGetPaperTool(makeDeps(client))
    await assert.rejects(tool.execute({ bibcode: docAtmos.bibcode }, makeExec()), (e) => e.code === code)
    assert.equal(calls, 1)
  }
})

test('invalid bibcode arguments → ToolArgsError', async () => {
  const tool = createGetPaperTool(makeDeps(createFakeClient({ request: () => searchResponse([]) })))
  for (const bibcode of ['has space', 'x"y', '', 'a/b']) {
    await assert.rejects(tool.execute({ bibcode }, makeExec()), (e) => e.name === 'ToolArgsError')
  }
})
