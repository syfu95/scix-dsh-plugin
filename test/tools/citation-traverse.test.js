/**
 * citation_traverse: graph one-hop + bounded chain (depth 2) with bibcode OR
 * metadata batching; relation labels; validation; error propagation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createCitationTraverseTool, GRAPH_ROWS, CHAIN_MAX_NODES_PER_HOP } = await import('../../src/tools/citation-traverse.js')
const { createFakeClient, makeDeps, makeExec, searchResponse, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { validateToolOutput } = await import('./helpers/dsh-stub.js')
const { docAtmos, docNonArxiv } = await import('./fixtures.js')
forbidRealNetwork()

const SEED = '2021arXiv210301234X'

test('graph backward: references() operator, relation labels, truncation vs numFound', async () => {
  const client = createFakeClient({
    request(path, options) {
      assert.equal(path, '/search/query')
      assert.equal(options.params.q, `references(bibcode:"${SEED}")`)
      assert.equal(options.params.rows, GRAPH_ROWS)
      assert.equal(options.params.sort, 'citation_count desc')
      return searchResponse([docAtmos, docNonArxiv], 5)
    },
  })
  const deps = makeDeps(client)
  const tool = createCitationTraverseTool(deps)
  const exec = makeExec()
  const result = await tool.execute({ bibcode: SEED, direction: 'backward' }, exec)
  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.mode, 'graph')
  assert.equal(result.direction, 'backward')
  assert.deepEqual(result.papers.map((p) => p.relation), ['reference', 'reference'])
  assert.equal(result.papers[0].bibcode, docAtmos.bibcode)
  assert.equal(result.total_count, 5)
  assert.equal(result.returned_count, 2)
  assert.equal(result.truncated, true)
  assert.equal(result.added_to_working_set, 2)
  assert.equal(client.calls[0].options.signal, exec.signal)
})

test('graph forward: citations() operator with citation relation', async () => {
  const client = createFakeClient({
    request(path, options) {
      assert.equal(options.params.q, `citations(bibcode:"${SEED}")`)
      return searchResponse([docNonArxiv], 1)
    },
  })
  const tool = createCitationTraverseTool(makeDeps(client))
  const result = await tool.execute({ bibcode: SEED, direction: 'forward', mode: 'graph' }, makeExec())
  assert.equal(result.papers[0].relation, 'citation')
  assert.equal(result.truncated, false)
})

test('direction/mode enums hand-checked → ToolArgsError', async () => {
  const tool = createCitationTraverseTool(makeDeps(createFakeClient({ request: () => searchResponse([]) })))
  for (const args of [
    { bibcode: SEED, direction: 'sideways' },
    { bibcode: SEED, direction: 'backward', mode: 'tree' },
    { bibcode: SEED },
    { bibcode: 'bad code', direction: 'backward' },
  ]) {
    await assert.rejects(tool.execute(args, makeExec()), (e) => e.name === 'ToolArgsError')
  }
})

/** Chain fixture: seed → r1,r2,r3 → h1,h2 (backward references). */
function chainClient({ seedListSize = 3 } = {}) {
  const refs = Array.from({ length: seedListSize }, (_, i) => `R${i + 1}`)
  const hop1Docs = [
    { bibcode: 'R1', title: ['Ref One'], year: '2018', citation_count: 10, reference: ['H1'], doctype: 'article' },
    { bibcode: 'R2', title: ['Ref Two'], year: '2019', citation_count: 50, reference: ['H1', 'H2'], doctype: 'article' },
    { bibcode: 'R3', title: ['Ref Three'], year: '2020', citation_count: 20, reference: [], doctype: 'article' },
  ].slice(0, Math.min(seedListSize, 3))
  const hop2Docs = [
    { bibcode: 'H1', title: ['Hop Two One'], year: '2015', citation_count: 5, doctype: 'article' },
    { bibcode: 'H2', title: ['Hop Two Two'], year: '2016', citation_count: 3, doctype: 'article' },
  ]
  const client = createFakeClient({
    request(path, options) {
      const q = options.params.q
      if (q === `bibcode:"${SEED}"`) {
        assert.ok(options.params.fl.includes('reference'))
        assert.ok(options.params.fl.includes('citation'))
        return searchResponse([{ bibcode: SEED, title: ['Seed'], year: '2021', citation_count: 42, reference: refs, citation: ['C1'] }], 1)
      }
      if (q.startsWith('bibcode:(') && options.params.fl.includes('reference') && !options.params.fl.includes('title')) {
        // hop-2 raw link fetch for the top-5 hop-1 papers
        assert.deepEqual(q, 'bibcode:("R2" OR "R3" OR "R1")') // citation_count desc: 50, 20, 10
        return searchResponse(hop1Docs.map((d) => ({ bibcode: d.bibcode, reference: d.reference, citation: [] })))
      }
      if (q.startsWith('bibcode:(')) {
        const asked = q.match(/"([^"]+)"/g).map((s) => s.slice(1, -1))
        const pool = [...hop1Docs, ...hop2Docs]
        return searchResponse(pool.filter((d) => asked.includes(d.bibcode)), asked.length)
      }
      throw new Error(`unexpected query ${q}`)
    },
  })
  return { client, refs }
}

test('chain backward: depth-2 nodes/edges, OR-batched metadata, bounded requests', async () => {
  const { client } = chainClient()
  const deps = makeDeps(client)
  const tool = createCitationTraverseTool(deps)
  const result = await tool.execute({ bibcode: SEED, direction: 'backward', mode: 'chain' }, makeExec())
  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.mode, 'chain')
  assert.equal(result.max_depth, 2)
  assert.equal(result.truncated, false)
  const byBib = new Map(result.nodes.map((n) => [n.bibcode, n]))
  assert.equal(byBib.get(SEED).depth, 0)
  assert.equal(byBib.get(SEED).relation, null)
  assert.equal(byBib.get('R2').depth, 1)
  assert.equal(byBib.get('R2').relation, 'reference')
  assert.equal(byBib.get('H1').depth, 2)
  assert.equal(result.nodes.length, 6)
  // Edges always point citing → cited: seed references R*, R* reference H*.
  const edgeSet = new Set(result.edges.map((e) => `${e.citing}>${e.cited}`))
  for (const r of ['R1', 'R2', 'R3']) assert.ok(edgeSet.has(`${SEED}>${r}`))
  assert.ok(edgeSet.has('R2>H1'))
  assert.ok(edgeSet.has('R2>H2'))
  assert.ok(edgeSet.has('R1>H1'))
  assert.equal(result.edges.length, 6)
  assert.ok(result.expansion_note.includes('max depth 2'))
  assert.equal(result.added_to_working_set, 5) // seed excluded from add
  // Requests: seed raw + hop1 metadata + hop2 raw + hop2 metadata = 4.
  assert.equal(client.calls.length, 4)
})

test('chain forward: edges invert (citing paper → seed)', async () => {
  const client = createFakeClient({
    request(path, options) {
      const q = options.params.q
      if (q === `bibcode:"${SEED}"`) {
        return searchResponse([{ bibcode: SEED, title: ['Seed'], year: '2021', citation_count: 42, reference: [], citation: ['F1'] }], 1)
      }
      if (q === 'bibcode:("F1")' && options.params.fl.includes('reference') && !options.params.fl.includes('title')) {
        return searchResponse([{ bibcode: 'F1', reference: [], citation: ['F2'] }])
      }
      if (q === 'bibcode:("F1")') {
        return searchResponse([{ bibcode: 'F1', title: ['Citer One'], year: '2022', citation_count: 7, doctype: 'article' }])
      }
      if (q === 'bibcode:("F2")') {
        return searchResponse([{ bibcode: 'F2', title: ['Citer Two'], year: '2023', citation_count: 2, doctype: 'article' }])
      }
      throw new Error(`unexpected query ${q}`)
    },
  })
  const tool = createCitationTraverseTool(makeDeps(client))
  const result = await tool.execute({ bibcode: SEED, direction: 'forward', mode: 'chain' }, makeExec())
  const edgeSet = new Set(result.edges.map((e) => `${e.citing}>${e.cited}`))
  assert.ok(edgeSet.has(`F1>${SEED}`))
  assert.ok(edgeSet.has(`F2>F1`))
  assert.equal(result.nodes.find((n) => n.bibcode === 'F2').depth, 2)
})

test('chain caps raw lists at 200 per hop and batches metadata ≤50 per OR query', async () => {
  const { client, refs } = chainClient({ seedListSize: CHAIN_MAX_NODES_PER_HOP + 50 })
  const tool = createCitationTraverseTool(makeDeps(client))
  const result = await tool.execute({ bibcode: SEED, direction: 'backward', mode: 'chain' }, makeExec())
  assert.equal(result.truncated, true)
  const metadataCalls = client.calls.filter((c) => c.options.params.fl.includes('title') && c.options.params.q.startsWith('bibcode:('))
  assert.ok(metadataCalls.length >= 4) // 200 hop-1 bibcodes → 4 batches of 50
  for (const call of metadataCalls) {
    const asked = call.options.params.q.match(/"([^"]+)"/g)
    assert.ok(asked.length <= 50)
    assert.equal(call.options.params.rows, asked.length)
  }
  // Only the first 200 raw bibcodes were processed.
  const allAsked = metadataCalls.flatMap((c) => c.options.params.q.match(/"([^"]+)"/g).map((s) => s.slice(1, -1)))
  assert.ok(allAsked.includes(refs[199]))
  assert.ok(!allAsked.includes(refs[200]))
})

test('chain seed not found → API_ERROR 404; TOKEN_MISSING propagates in both modes', async () => {
  const notFound = createFakeClient({ request: () => searchResponse([], 0) })
  const tool = createCitationTraverseTool(makeDeps(notFound))
  await assert.rejects(
    tool.execute({ bibcode: SEED, direction: 'backward', mode: 'chain' }, makeExec()),
    (e) => e.code === 'API_ERROR' && e.status === 404,
  )
  for (const mode of ['graph', 'chain']) {
    const missing = createFakeClient({ request: () => { throw scixError(ERROR_CODES.TOKEN_MISSING, 'no token') } })
    const tool2 = createCitationTraverseTool(makeDeps(missing))
    await assert.rejects(
      tool2.execute({ bibcode: SEED, direction: 'forward', mode }, makeExec()),
      (e) => e.code === 'TOKEN_MISSING',
    )
  }
})
