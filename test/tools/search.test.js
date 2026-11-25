/**
 * search tool: dual-path RRF fusion with a fake client, filters, validation,
 * degradation, TOKEN_MISSING propagation, working-set auto-add, session keys.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createSearchTool } = await import('../../src/tools/search.js')
const { createFakeClient, makeDeps, makeExec, searchResponse, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { validateToolOutput } = await import('./helpers/dsh-stub.js')
const { docAtmos, docNonArxiv, docArxivNoSignals } = await import('./fixtures.js')
forbidRealNetwork()

const QUERY = 'JWST exoplanet atmospheres'

function dualPathClient() {
  return createFakeClient({
    request(path, options) {
      assert.equal(path, '/search/query')
      if (options.params.q === QUERY) {
        assert.equal(options.params.sort, 'score desc')
        return searchResponse([docAtmos, docNonArxiv, docArxivNoSignals], 3)
      }
      assert.equal(options.params.q, `similar(bibcode:"${docAtmos.bibcode}")`)
      return searchResponse([docArxivNoSignals, docAtmos], 2)
    },
  })
}

test('happy path: dual-path RRF fusion, verbatim bibcodes, seed documented, working set auto-add', async () => {
  const client = dualPathClient()
  const deps = makeDeps(client)
  const tool = createSearchTool(deps)
  const exec = makeExec()
  const result = await tool.execute({ query: QUERY }, exec)

  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.fusion, 'dual-path')
  assert.equal(result.ranking, 'rrf-fusion')
  assert.equal(result.ranking_k, 60)
  assert.ok(result.ranking_note.includes('NOT vector/embedding semantics'))
  assert.equal(result.similar_seed_bibcode, docAtmos.bibcode)
  // Fused order: atmos (1/61+1/62) > nosignals (1/63+1/61) > nonarxiv (1/62).
  assert.deepEqual(result.papers.map((p) => p.bibcode),
    [docAtmos.bibcode, docArxivNoSignals.bibcode, docNonArxiv.bibcode])
  assert.deepEqual(result.papers[0].lexical_rank, 1)
  assert.deepEqual(result.papers[0].similar_rank, 2)
  assert.equal(result.papers[0].body_available, true)
  assert.equal(result.papers[2].body_available, false)
  assert.equal(result.papers[0].title, docAtmos.title[0])
  assert.equal(result.total_count, 3)
  assert.equal(result.returned_count, 3)
  assert.equal(result.truncated, false)
  assert.equal(result.working_set_id, 'ws-default')
  assert.equal(result.added_to_working_set, 3)
  assert.equal(deps.workingSets.get('session-test').size, 3)
  // exec.signal forwarded on BOTH requests.
  for (const call of client.calls) assert.equal(call.options.signal, exec.signal)
  // render is lossless model-facing content.
  const rendered = tool.output.render({ query: QUERY }, result)
  assert.equal(rendered[0].type, 'text')
  assert.deepEqual(JSON.parse(rendered[0].text), result)
})

test('filters map to fq exactly; pool rows bounded; numeric uat unquoted', async () => {
  const client = createFakeClient({
    request: () => searchResponse([], 0),
  })
  const tool = createSearchTool(makeDeps(client))
  await tool.execute({
    query: 'x', year_min: 2019, year_max: 2021, arxiv_class: 'astro-ph.EP',
    doctype: 'article', first_author: 'Smith, J', uat: 'Exoplanet atmospheres', limit: 5,
  }, makeExec())
  const params = client.calls[0].options.params
  assert.deepEqual(params.fq, [
    'year:[2019 TO 2021]',
    'arxiv_class:"astro-ph.EP"',
    'doctype:"article"',
    'first_author:"Smith, J"',
    'uat:"Exoplanet atmospheres"',
  ])
  assert.equal(params.rows, 30) // max(limit*3, 30)
  assert.equal(client.calls.length, 1) // no hits → no similar() seed

  const client2 = createFakeClient({ request: () => searchResponse([], 0) })
  const tool2 = createSearchTool(makeDeps(client2))
  await tool2.execute({ query: 'x', uat: '1234', year_min: 2000 }, makeExec())
  assert.deepEqual(client2.calls[0].options.params.fq, ['year:[2000 TO *]', 'uat:1234'])
})

test('argument validation: limit range, year order, doctype enum, empty query → ToolArgsError', async () => {
  const tool = createSearchTool(makeDeps(createFakeClient({ request: () => searchResponse([]) })))
  for (const args of [
    { query: 'x', limit: 0 },
    { query: 'x', limit: 101 },
    { query: 'x', limit: 1.5 },
    { query: 'x', year_min: 2022, year_max: 2020 },
    { query: 'x', doctype: 'bogus' },
    { query: '   ' },
    {},
  ]) {
    await assert.rejects(tool.execute(args, makeExec()), (error) => {
      assert.equal(error.name, 'ToolArgsError')
      assert.equal(error.code, 'INVALID_ARGS')
      return true
    })
  }
})

test('similar() failure degrades to lexical-only with an honest note; aborts propagate', async () => {
  const client = createFakeClient({
    request(path, options, index) {
      if (index === 0) return searchResponse([docAtmos, docNonArxiv], 2)
      throw scixError(ERROR_CODES.RATE_LIMITED, 'burst limit', { status: 429 })
    },
  })
  const tool = createSearchTool(makeDeps(client))
  const result = await tool.execute({ query: QUERY }, makeExec())
  assert.equal(result.fusion, 'lexical-only')
  assert.ok(result.fusion_note.includes('RATE_LIMITED'))
  assert.deepEqual(result.papers.map((p) => p.bibcode), [docAtmos.bibcode, docNonArxiv.bibcode])
  assert.equal(result.papers[0].similar_rank, null)
  assert.deepEqual(validateToolOutput(tool, result), [])

  const aborting = createFakeClient({
    request(path, options, index) {
      if (index === 0) return searchResponse([docAtmos], 1)
      throw scixError(ERROR_CODES.ABORTED, 'aborted')
    },
  })
  const tool2 = createSearchTool(makeDeps(aborting))
  await assert.rejects(tool2.execute({ query: QUERY }, makeExec()), (e) => e.code === 'ABORTED')
})

test('TOKEN_MISSING / QUOTA_EXCEEDED propagate untouched from the lexical path', async () => {
  for (const code of [ERROR_CODES.TOKEN_MISSING, ERROR_CODES.QUOTA_EXCEEDED, ERROR_CODES.API_ERROR]) {
    const client = createFakeClient({ request: () => { throw scixError(code, `fail ${code}`) } })
    const tool = createSearchTool(makeDeps(client))
    await assert.rejects(tool.execute({ query: QUERY }, makeExec()), (error) => {
      assert.equal(error.name, 'ScixError')
      assert.equal(error.code, code)
      return true
    })
  }
})

test('zero lexical hits: empty result, no similar call, explicit note', async () => {
  const client = createFakeClient({ request: () => searchResponse([], 0) })
  const tool = createSearchTool(makeDeps(client))
  const result = await tool.execute({ query: 'nothing matches' }, makeExec())
  assert.deepEqual(result.papers, [])
  assert.equal(result.total_count, 0)
  assert.equal(result.fusion, 'lexical-only')
  assert.equal(result.similar_seed_bibcode, null)
  assert.equal(client.calls.length, 1)
  assert.equal(result.added_to_working_set, 0)
})

test('limit truncates fused results and flags truncation vs numFound', async () => {
  const tool = createSearchTool(makeDeps(dualPathClient()))
  const result = await tool.execute({ query: QUERY, limit: 2 }, makeExec())
  assert.equal(result.papers.length, 2)
  assert.equal(result.returned_count, 2)
  assert.equal(result.truncated, true)
})

test('working sets are session-scoped via exec.agent.id', async () => {
  const deps = makeDeps(dualPathClient())
  const tool = createSearchTool(deps)
  await tool.execute({ query: QUERY }, makeExec({ sessionId: 'session-A' }))
  await tool.execute({ query: QUERY }, makeExec({ sessionId: 'session-B' }))
  assert.equal(deps.workingSets.get('session-A').size, 3)
  assert.equal(deps.workingSets.get('session-B').size, 3)
  assert.deepEqual(deps.workingSets.list('session-C'), [])
  // Re-running the same session adds nothing new (dedupe).
  const again = await tool.execute({ query: QUERY }, makeExec({ sessionId: 'session-A' }))
  assert.equal(again.added_to_working_set, 0)
})
