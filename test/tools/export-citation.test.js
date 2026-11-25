/**
 * export_citation: DETERMINISTIC server-side export passthrough. Fixture API
 * response → byte-exact expected BibTeX/RIS/AASTeX text; zero client-side
 * field invention; request shape; validation; error propagation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createExportCitationTool, EXPORT_FORMATS } = await import('../../src/tools/export-citation.js')
const { createFakeClient, makeDeps, makeExec, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { exportBibtex, exportRis, exportAastex } = await import('./fixtures.js')
forbidRealNetwork()

const BIBCODES = ['2021arXiv210301234X', '2020ApJ...890..123D']
const FIXTURES = { bibtex: exportBibtex, aastex: exportAastex, ris: exportRis }

test('formats enum is exactly bibtex/aastex/ris', () => {
  assert.deepEqual([...EXPORT_FORMATS], ['bibtex', 'aastex', 'ris'])
})

for (const format of ['bibtex', 'aastex', 'ris']) {
  test(`${format}: API export text returned VERBATIM (byte-exact), deterministic across calls`, async () => {
    const client = createFakeClient({
      request(path, options) {
        assert.equal(path, `/export/${format}`)
        assert.equal(options.method, 'POST')
        assert.deepEqual(options.body, { bibcode: BIBCODES })
        assert.equal(options.params, undefined) // no sort → server default ordering
        return { export: FIXTURES[format] }
      },
    })
    const tool = createExportCitationTool(makeDeps(client))
    const exec = makeExec()
    const first = await tool.execute({ bibcodes: BIBCODES, format }, exec)
    const second = await tool.execute({ bibcodes: BIBCODES, format }, exec)
    assert.equal(first, FIXTURES[format])
    assert.equal(second, first)
    assert.equal(typeof first, 'string')
    // render passes the text through untouched.
    assert.deepEqual(tool.output.render({ bibcodes: BIBCODES, format }, first), [{ type: 'text', text: FIXTURES[format] }])
    assert.equal(client.calls[0].options.signal, exec.signal)
  })
}

test('bibtex fixture content: author/year/eid/adsurl fields exactly as the API produced them', async () => {
  const client = createFakeClient({ request: () => ({ export: exportBibtex }) })
  const tool = createExportCitationTool(makeDeps(client))
  const text = await tool.execute({ bibcodes: BIBCODES, format: 'bibtex' }, makeExec())
  assert.ok(text.startsWith('@ARTICLE{2021arXiv210301234X,'))
  assert.ok(text.includes('author = {{Smith}, Jane and {Doe}, John}'))
  assert.ok(text.includes('year = 2021'))
  assert.ok(text.includes('eid = {arXiv:2103.01234}'))
  assert.ok(text.endsWith('}\n'))
})

test('exact duplicates removed preserving order; distinct entries untouched', async () => {
  let body = null
  const client = createFakeClient({
    request(path, options) { body = options.body; return { export: exportBibtex } },
  })
  const tool = createExportCitationTool(makeDeps(client))
  await tool.execute({ bibcodes: ['A1', 'A1', 'B2', 'A1'], format: 'bibtex' }, makeExec())
  assert.deepEqual(body.bibcode, ['A1', 'B2'])
})

test('validation: format enum, empty/invalid/oversized bibcodes → ToolArgsError', async () => {
  const tool = createExportCitationTool(makeDeps(createFakeClient({ request: () => ({ export: '' }) })))
  for (const args of [
    { bibcodes: BIBCODES, format: 'endnote' },
    { bibcodes: BIBCODES, format: 'BibTeX' },
    { bibcodes: [], format: 'bibtex' },
    { bibcodes: 'not-an-array', format: 'bibtex' },
    { bibcodes: ['has space'], format: 'bibtex' },
    { bibcodes: Array.from({ length: 2001 }, (_, i) => `B${i}`), format: 'ris' },
    { bibcodes: BIBCODES },
  ]) {
    await assert.rejects(tool.execute(args, makeExec()), (e) => {
      assert.equal(e.name, 'ToolArgsError')
      assert.equal(e.code, 'INVALID_ARGS')
      return true
    })
  }
})

test('missing export field → ScixError API_ERROR (nothing generated client-side)', async () => {
  for (const response of [{}, { export: 42 }, null]) {
    const client = createFakeClient({ request: () => response })
    const tool = createExportCitationTool(makeDeps(client))
    await assert.rejects(tool.execute({ bibcodes: BIBCODES, format: 'bibtex' }, makeExec()), (error) => {
      assert.equal(error.name, 'ScixError')
      assert.equal(error.code, 'API_ERROR')
      assert.ok(error.message.includes('Nothing was generated client-side'))
      return true
    })
  }
})

test('TOKEN_MISSING / RATE_LIMITED / ABORTED propagate untouched', async () => {
  for (const code of [ERROR_CODES.TOKEN_MISSING, ERROR_CODES.RATE_LIMITED, ERROR_CODES.ABORTED]) {
    const client = createFakeClient({ request: () => { throw scixError(code, 'fail') } })
    const tool = createExportCitationTool(makeDeps(client))
    await assert.rejects(tool.execute({ bibcodes: BIBCODES, format: 'ris' }, makeExec()), (e) => e.code === code)
  }
})
