/**
 * find_gaps: client-side heuristic over a real working set; batched member
 * links + neighbor metadata; unknown-id error; exclusions; member cap.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createFindGapsTool } = await import('../../src/tools/find-gaps.js')
const { createFakeClient, makeDeps, makeExec, searchResponse, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { validateToolOutput } = await import('./helpers/dsh-stub.js')
const { GAP_LIMITS } = await import('../../src/tools/gaps.js')
forbidRealNetwork()

const M1 = '2015ApJ...800....1M'
const M2 = '2016ApJ...810....2M'
const M3 = '2017ApJ...820....3M'

const memberDocs = [
  { bibcode: M1, title: ['Member One'], author: ['Smith, Jane'], year: '2015', uat: ['Exoplanets'], keyword: ['transits'], reference: ['E1', 'E2', 'E3'], citation: ['E4', 'E5'] },
  { bibcode: M2, title: ['Member Two'], author: ['Smith, Jane'], year: '2016', uat: ['Exoplanets'], keyword: ['transits'], reference: ['E1', 'E2'], citation: ['E4', 'E6'] },
  { bibcode: M3, title: ['Member Three'], author: ['Doe, John'], year: '2017', uat: ['Exoplanets'], keyword: ['transits'], reference: ['E2', 'E3'], citation: ['E5', 'E6'] },
]
const neighborDocs = [
  { bibcode: 'E1', title: ['External One'], year: '2022', citation_count: 100, uat: ['Gravitational waves'], keyword: ['LIGO'], first_author: 'Fu, Mei' },
  { bibcode: 'E2', title: ['External Two'], year: '2022', citation_count: 90, uat: ['Gravitational waves'], first_author: 'Fu, Mei' },
  { bibcode: 'E3', title: ['External Three'], year: '2022', citation_count: 80, keyword: ['LIGO'], first_author: 'Gao, Lin' },
  { bibcode: 'E4', title: ['External Four'], year: '2023', citation_count: 70, uat: ['Gravitational waves'], first_author: 'Fu, Mei' },
  { bibcode: 'E5', title: ['External Five'], year: '2023', citation_count: 60, keyword: ['LIGO'], first_author: 'Gao, Lin' },
  { bibcode: 'E6', title: ['External Six'], year: '2023', citation_count: 50, uat: ['Black holes'], first_author: 'Hu, Bo' },
]

function gapsClient() {
  return createFakeClient({
    request(path, options) {
      assert.equal(path, '/search/query')
      const q = options.params.q
      if (q === `bibcode:("${M1}" OR "${M2}" OR "${M3}")`) {
        assert.ok(options.params.fl.includes('reference'))
        assert.ok(options.params.fl.includes('citation'))
        assert.ok(options.params.fl.includes('uat'))
        return searchResponse(memberDocs, 3)
      }
      assert.ok(q.startsWith('bibcode:('))
      assert.ok(options.params.fl.includes('keyword'))
      const asked = q.match(/"([^"]+)"/g).map((s) => s.slice(1, -1))
      assert.ok(asked.length <= 50)
      return searchResponse(neighborDocs.filter((d) => asked.includes(d.bibcode)), asked.length)
    },
  })
}

async function seededDeps(client) {
  const deps = makeDeps(client)
  deps.workingSets.add('session-test', memberDocs.map((d) => ({ bibcode: d.bibcode, title: d.title[0], year: Number(d.year) })))
  return deps
}

test('happy path: heuristic candidates/temporal/topic/author gaps with verbatim evidence', async () => {
  const client = gapsClient()
  const deps = await seededDeps(client)
  const tool = createFindGapsTool(deps)
  const result = await tool.execute({ working_set_id: 'ws-default' }, makeExec())
  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.method, 'client-side-heuristic')
  assert.ok(result.note.includes('NOT PageRank'))
  assert.equal(result.set_size, 3)
  assert.equal(result.analyzed_members, 3)
  assert.deepEqual(result.candidates.map((c) => c.bibcode), ['E2', 'E1', 'E3', 'E4', 'E5', 'E6'])
  assert.equal(result.candidates[0].link_count, 3)
  assert.deepEqual(result.candidates[0].linked_by, [M1, M2, M3])
  assert.deepEqual(result.temporal_gaps, [{ year_min: 2022, year_max: 2023, neighbor_count: 6, evidence: ['E1', 'E2', 'E3'] }])
  assert.deepEqual(result.topic_gaps.map((g) => g.term), ['Gravitational waves', 'LIGO'])
  assert.deepEqual(result.author_gaps.map((g) => g.author), ['Fu, Mei', 'Gao, Lin'])
  assert.equal(result.stats.external_papers_linked, 6)
  // Member batch + one neighbor batch (6 bibcodes ≤ 50).
  assert.equal(client.calls.length, 2)
})

test('unknown working_set_id → actionable ScixError; empty id → ToolArgsError', async () => {
  const tool = createFindGapsTool(makeDeps(createFakeClient({ request: () => searchResponse([]) })))
  await assert.rejects(tool.execute({ working_set_id: 'ws-nope' }, makeExec()), (error) => {
    assert.equal(error.name, 'ScixError')
    assert.equal(error.code, 'API_ERROR')
    assert.ok(error.message.includes('ws-default'))
    return true
  })
  await assert.rejects(tool.execute({ working_set_id: '' }, makeExec()), (e) => e.name === 'ToolArgsError')
})

test('empty working set → explicit empty analysis, no API calls', async () => {
  const client = createFakeClient({ request: () => { throw new Error('no calls expected') } })
  const deps = makeDeps(client)
  deps.workingSets.set('session-test', [], 'ws-empty')
  const tool = createFindGapsTool(deps)
  const result = await tool.execute({ working_set_id: 'ws-empty' }, makeExec())
  assert.equal(result.analyzed_members, 0)
  assert.deepEqual(result.candidates, [])
  assert.ok(result.note.includes('empty'))
  assert.equal(client.calls.length, 0)
  assert.deepEqual(validateToolOutput(tool, result), [])
})

test('excluded members are filtered from candidates and facets', async () => {
  const client = gapsClient()
  const deps = await seededDeps(client)
  deps.workingSets.exclude('session-test', ['E2', 'E6'])
  const tool = createFindGapsTool(deps)
  const result = await tool.execute({ working_set_id: 'ws-default' }, makeExec())
  assert.ok(!result.candidates.some((c) => c.bibcode === 'E2' || c.bibcode === 'E6'))
  assert.ok(!result.topic_gaps.some((g) => g.term === 'Black holes'))
  assert.equal(result.stats.external_papers_linked, 4)
})

test('member cap: >10 members analyzed partially with members_truncated flag', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ bibcode: `2015ApJ...800....${i}M`, title: [`M${i}`], year: '2015', reference: [], citation: [] }))
  const client = createFakeClient({
    request(path, options) {
      const asked = options.params.q.match(/"([^"]+)"/g)
      assert.equal(asked.length, GAP_LIMITS.MAX_ANALYZED_MEMBERS)
      assert.equal(options.params.rows, GAP_LIMITS.MAX_ANALYZED_MEMBERS)
      return searchResponse(many.slice(0, GAP_LIMITS.MAX_ANALYZED_MEMBERS), 10)
    },
  })
  const deps = makeDeps(client)
  deps.workingSets.add('session-test', many.map((d) => ({ bibcode: d.bibcode })))
  const tool = createFindGapsTool(deps)
  const result = await tool.execute({ working_set_id: 'ws-default' }, makeExec())
  assert.equal(result.members_truncated, true)
  assert.equal(result.analyzed_members, 10)
  assert.equal(result.set_size, 12)
  assert.ok(result.note.includes('first 10'))
})

test('TOKEN_MISSING propagates; session isolation honored', async () => {
  const missing = createFakeClient({ request: () => { throw scixError(ERROR_CODES.TOKEN_MISSING, 'no token') } })
  const deps = await seededDeps(missing)
  const tool = createFindGapsTool(deps)
  await assert.rejects(tool.execute({ working_set_id: 'ws-default' }, makeExec()), (e) => e.code === 'TOKEN_MISSING')
  // Another session cannot see this session's set.
  await assert.rejects(tool.execute({ working_set_id: 'ws-default' }, makeExec({ sessionId: 'other-session' })), (e) => e.code === 'API_ERROR')
})
