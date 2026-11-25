/**
 * forward_citations: ADS citations() + best-effort S2 intents; verbatim
 * taxonomy; honest degradation on 429/transport/invalid JSON/no key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createForwardCitationsTool, FORWARD_ROWS } = await import('../../src/tools/forward-citations.js')
const { createFakeClient, makeDeps, makeExec, searchResponse, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { validateToolOutput } = await import('./helpers/dsh-stub.js')
const { docAtmos, citingMethod, citingBackground, citingEmptyIntents, citingUnmatched, s2Page } = await import('./fixtures.js')
forbidRealNetwork()

const SEED = docAtmos.bibcode
const CITATIONS = [citingMethod, citingBackground, citingEmptyIntents, citingUnmatched]

function adsHandler(seedDoc = docAtmos) {
  return (path, options) => {
    assert.equal(path, '/search/query')
    if (options.params.q === `bibcode:"${SEED}"`) {
      assert.deepEqual(options.params.fl.split(',').sort(), ['bibcode', 'doi', 'eid', 'identifier'].sort())
      return searchResponse([seedDoc], 1)
    }
    assert.equal(options.params.q, `citations(bibcode:"${SEED}")`)
    assert.equal(options.params.rows, FORWARD_ROWS)
    assert.equal(options.params.sort, 'citation_count desc')
    return searchResponse(CITATIONS, 12)
  }
}

test('happy path: real S2 intents attached verbatim with source; coverage honest', async () => {
  const client = createFakeClient({
    request: adsHandler(),
    requestExternal(url, options) {
      assert.ok(url.startsWith('https://api.semanticscholar.org/graph/v1/paper/DOI%3A10.1051%2F0004-6361%2F202140001/citations'))
      assert.ok(url.includes('fields=intents,contexts,title,externalIds'))
      assert.ok(url.includes('limit=100'))
      assert.equal(options.accept, 'application/json')
      return { status: 200, headers: {}, text: JSON.stringify(s2Page) }
    },
  })
  const deps = makeDeps(client)
  const tool = createForwardCitationsTool(deps)
  const exec = makeExec()
  const result = await tool.execute({ bibcode: SEED }, exec)
  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.total_count, 12)
  assert.equal(result.returned_count, 4)
  assert.equal(result.truncated, true)
  assert.equal(result.s2_paper_key, 'DOI:10.1051/0004-6361/202140001')

  const byBib = new Map(result.citations.map((c) => [c.bibcode, c]))
  const method = byBib.get(citingMethod.bibcode)
  assert.deepEqual(method.intents, ['method'])
  assert.equal(method.intent_source, 'semantic-scholar')
  assert.equal(method.is_influential, true)
  assert.ok(method.intent_contexts[0].includes('We use the method'))
  assert.equal(method.contexts_truncated, false)
  assert.deepEqual(method.doi, citingMethod.doi) // verbatim ADS DOI
  const background = byBib.get(citingBackground.bibcode)
  assert.deepEqual(background.intents, ['background']) // matched via case-normalized DOI
  assert.deepEqual(background.doi, citingBackground.doi) // returned VERBATIM (uppercase)
  const empty = byBib.get(citingEmptyIntents.bibcode)
  assert.deepEqual(empty.intents, []) // matched, unlabeled — distinct from null
  assert.equal(empty.intent_source, 'semantic-scholar')
  const unmatched = byBib.get(citingUnmatched.bibcode)
  assert.equal(unmatched.intents, null)
  assert.equal(unmatched.intent_source, null)

  assert.deepEqual(result.intent_coverage, { returned: 4, matched: 3, with_intents: 2 })
  assert.ok(result.note.includes('background/method/result_comparison'))
  assert.ok(result.note.includes('never generated'))
  assert.ok(!result.note.includes('DEGRADED'))
  assert.equal(result.added_to_working_set, 4)
  assert.equal(client.calls[2].options.signal, exec.signal)
})

test('S2 429 → every intents:null + DEGRADED note; ADS list still returned', async () => {
  const client = createFakeClient({
    request: adsHandler(),
    requestExternal: () => ({ status: 429, headers: {}, text: '{"message":"rate limited"}' }),
  })
  const tool = createForwardCitationsTool(makeDeps(client))
  const result = await tool.execute({ bibcode: SEED }, makeExec())
  assert.equal(result.returned_count, 4)
  for (const citation of result.citations) {
    assert.equal(citation.intents, null)
    assert.equal(citation.intent_source, null)
  }
  assert.deepEqual(result.intent_coverage, { returned: 4, matched: 0, with_intents: 0 })
  assert.ok(result.note.includes('DEGRADED'))
  assert.ok(result.note.includes('429'))
  assert.deepEqual(validateToolOutput(tool, result), [])
})

test('S2 transport failure and invalid JSON degrade honestly; ABORTED propagates', async () => {
  for (const external of [
    () => { throw scixError(ERROR_CODES.API_ERROR, 'connection reset') },
    () => ({ status: 200, headers: {}, text: 'not json {{{' }),
    () => ({ status: 503, headers: {}, text: '' }),
  ]) {
    const client = createFakeClient({ request: adsHandler(), requestExternal: external })
    const tool = createForwardCitationsTool(makeDeps(client))
    const result = await tool.execute({ bibcode: SEED }, makeExec())
    assert.ok(result.note.includes('DEGRADED'))
    assert.ok(result.citations.every((c) => c.intents === null))
  }
  const aborting = createFakeClient({
    request: adsHandler(),
    requestExternal: () => { throw scixError(ERROR_CODES.ABORTED, 'aborted') },
  })
  const tool = createForwardCitationsTool(makeDeps(aborting))
  await assert.rejects(tool.execute({ bibcode: SEED }, makeExec()), (e) => e.code === 'ABORTED')
})

test('no DOI/arXiv on target → S2 skipped entirely with explicit note', async () => {
  // Non-arXiv bibcode with no doi/identifier/eid: no S2 key can be built
  // (bibcode parsing only recognizes arXiv bibstems).
  const plainBib = '2020ApJ...890..123D'
  const client = createFakeClient({
    request(path, options) {
      if (options.params.q === `bibcode:"${plainBib}"`) return searchResponse([{ bibcode: plainBib }], 1)
      return searchResponse(CITATIONS, 4)
    },
    requestExternal: () => { throw new Error('must not be called') },
  })
  const tool = createForwardCitationsTool(makeDeps(client))
  const result = await tool.execute({ bibcode: plainBib }, makeExec())
  assert.equal(result.s2_paper_key, null)
  assert.ok(result.note.includes('matching skipped'))
  assert.equal(client.calls.filter((c) => c.kind === 'external').length, 0)
})

test('ARXIV key fallback when the target has no DOI', async () => {
  const seedNoDoi = { bibcode: SEED, identifier: ['arXiv:2103.01234'], eid: 'arXiv:2103.01234' }
  let sawUrl = null
  const client = createFakeClient({
    request: adsHandler(seedNoDoi),
    requestExternal(url) {
      sawUrl = url
      return { status: 200, headers: {}, text: JSON.stringify({ data: [] }) }
    },
  })
  const tool = createForwardCitationsTool(makeDeps(client))
  const result = await tool.execute({ bibcode: SEED }, makeExec())
  assert.equal(result.s2_paper_key, 'ARXIV:2103.01234')
  assert.ok(sawUrl.includes('/paper/ARXIV%3A2103.01234/citations'))
  assert.deepEqual(result.intent_coverage, { returned: 4, matched: 0, with_intents: 0 })
})

test('empty citations list; TOKEN_MISSING propagation; invalid bibcode arg', async () => {
  const client = createFakeClient({
    request(path, options) {
      if (options.params.q.startsWith('bibcode:')) return searchResponse([docAtmos], 1)
      return searchResponse([], 0)
    },
    requestExternal: () => ({ status: 200, headers: {}, text: JSON.stringify({ data: [] }) }),
  })
  const tool = createForwardCitationsTool(makeDeps(client))
  const result = await tool.execute({ bibcode: SEED }, makeExec())
  assert.deepEqual(result.citations, [])
  assert.equal(result.total_count, 0)
  assert.equal(result.truncated, false)

  const missing = createFakeClient({ request: () => { throw scixError(ERROR_CODES.TOKEN_MISSING, 'no token') } })
  const tool2 = createForwardCitationsTool(makeDeps(missing))
  await assert.rejects(tool2.execute({ bibcode: SEED }, makeExec()), (e) => e.code === 'TOKEN_MISSING')
  await assert.rejects(tool2.execute({ bibcode: 'bad code' }, makeExec()), (e) => e.name === 'ToolArgsError')
})
