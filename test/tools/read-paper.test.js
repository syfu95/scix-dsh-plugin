/**
 * read_paper: arXiv HTML → ar5iv TEXT route only; section extraction on both
 * LaTeXML shapes; explicit body_available:false paths; truncation; aborts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createReadPaperTool, MAX_TEXT_CHARS } = await import('../../src/tools/read-paper.js')
const { createFakeClient, makeDeps, makeExec, searchResponse, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { validateToolOutput } = await import('./helpers/dsh-stub.js')
const { docAtmos, docNonArxiv, docArxivNoSignals, htmlNativeArxiv, htmlAr5iv } = await import('./fixtures.js')
forbidRealNetwork()

function htmlResponse(text, status = 200) {
  return { status, headers: { 'content-type': 'text/html' }, text }
}

test('happy path: native arXiv HTML, full text, structure, untrusted-content note', async () => {
  const client = createFakeClient({
    request: () => searchResponse([docAtmos], 1),
    requestExternal(url, options) {
      assert.equal(url, 'https://arxiv.org/html/2103.01234')
      assert.equal(options.accept, 'text/html')
      return htmlResponse(htmlNativeArxiv)
    },
  })
  const deps = makeDeps(client)
  const tool = createReadPaperTool(deps)
  const exec = makeExec()
  const result = await tool.execute({ bibcode: docAtmos.bibcode }, exec)
  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.body_available, true)
  assert.equal(result.body_source, 'arxiv-html')
  assert.equal(result.arxiv_id, '2103.01234')
  assert.ok(result.sections.includes('2 Methods'))
  assert.ok(result.text.includes('$E=mc^{2}$'))
  assert.ok(result.text.includes('Results paragraph two.'))
  assert.ok(result.note.includes('UNTRUSTED'))
  assert.equal(result.truncated, false)
  assert.equal(result.total_chars, result.text.length)
  assert.equal(client.calls.filter((c) => c.kind === 'external').length, 1)
  assert.equal(client.calls[1].options.signal, exec.signal)
  assert.equal(deps.workingSets.get('session-test').size, 1)
  // No PDF anywhere in the result.
  assert.ok(!JSON.stringify(result).toLowerCase().includes('.pdf'))
})

test('section selection: fuzzy title, id, abstract, and not-found with available list', async () => {
  const client = createFakeClient({
    request: () => searchResponse([docAtmos], 1),
    requestExternal: () => htmlResponse(htmlNativeArxiv),
  })
  const tool = createReadPaperTool(makeDeps(client))
  const methods = await tool.execute({ bibcode: docAtmos.bibcode, section: 'methods' }, makeExec())
  assert.equal(methods.section_title, '2 Methods')
  assert.ok(methods.text.includes('We fit'))
  assert.ok(!methods.text.includes('Results paragraph'))
  assert.equal(methods.body_available, true)

  const byId = await tool.execute({ bibcode: docAtmos.bibcode, section: 'S3' }, makeExec())
  assert.equal(byId.section_title, '3 Results')

  const abstract = await tool.execute({ bibcode: docAtmos.bibcode, section: 'abstract' }, makeExec())
  assert.equal(abstract.section_title, 'Abstract')
  assert.equal(abstract.text, 'We study atmospheres & clouds.')

  const missing = await tool.execute({ bibcode: docAtmos.bibcode, section: 'nonexistent' }, makeExec())
  assert.equal(missing.text, '')
  assert.equal(missing.body_available, true)
  assert.ok(missing.note.includes('No section matched'))
  assert.ok(missing.sections.includes('2 Methods'))
  assert.deepEqual(validateToolOutput(tool, missing), [])
})

test('ar5iv fallback when arxiv.org/html 404s; ar5iv LaTeXML shape parses', async () => {
  const urls = []
  const client = createFakeClient({
    request: () => searchResponse([docArxivNoSignals], 1),
    requestExternal(url) {
      urls.push(url)
      if (url.startsWith('https://arxiv.org/html/')) return htmlResponse('not found', 404)
      assert.equal(url, 'https://ar5iv.labs.arxiv.org/html/1901.01234')
      return htmlResponse(htmlAr5iv)
    },
  })
  const tool = createReadPaperTool(makeDeps(client))
  const result = await tool.execute({ bibcode: docArxivNoSignals.bibcode, section: '2.1 fitting' }, makeExec())
  assert.deepEqual(urls, ['https://arxiv.org/html/1901.01234', 'https://ar5iv.labs.arxiv.org/html/1901.01234'])
  assert.equal(result.body_source, 'ar5iv')
  assert.equal(result.body_available, true)
  assert.equal(result.section_title, '2.1. Fitting Procedure')
  assert.ok(result.text.includes('Ar5iv fitting details.'))
})

test('non-arXiv paper: no external fetch, body_available:false + abstract + explicit note', async () => {
  const client = createFakeClient({ request: () => searchResponse([docNonArxiv], 1) })
  const tool = createReadPaperTool(makeDeps(client))
  const result = await tool.execute({ bibcode: docNonArxiv.bibcode }, makeExec())
  assert.equal(client.calls.length, 1) // metadata only
  assert.equal(result.body_available, false)
  assert.equal(result.body_source, 'none')
  assert.deepEqual(result.sections, [])
  assert.equal(result.text, docNonArxiv.abstract)
  assert.ok(result.note.includes('No arXiv identifier'))
  assert.ok(result.note.includes('no body content was fabricated'))
  assert.deepEqual(validateToolOutput(tool, result), [])
})

test('both routes fail (404 + transport error) → body_available:false with abstract', async () => {
  const client = createFakeClient({
    request: () => searchResponse([docAtmos], 1),
    requestExternal(url) {
      if (url.startsWith('https://arxiv.org/html/')) return htmlResponse('', 404)
      throw scixError(ERROR_CODES.API_ERROR, 'connection reset')
    },
  })
  const tool = createReadPaperTool(makeDeps(client))
  const result = await tool.execute({ bibcode: docAtmos.bibcode }, makeExec())
  assert.equal(result.body_available, false)
  assert.equal(result.body_source, 'none')
  assert.equal(result.arxiv_id, '2103.01234')
  assert.equal(result.text, docAtmos.abstract)
  assert.ok(result.note.includes('HTTP 404'))
  assert.ok(result.note.includes('API_ERROR'))
})

test('200 responses without extractable text degrade to body_available:false', async () => {
  const client = createFakeClient({
    request: () => searchResponse([docAtmos], 1),
    requestExternal: () => htmlResponse('<html><body></body></html>'),
  })
  const tool = createReadPaperTool(makeDeps(client))
  const result = await tool.execute({ bibcode: docAtmos.bibcode }, makeExec())
  assert.equal(result.body_available, false)
  assert.ok(result.note.includes('no extractable LaTeXML text'))
})

test('truncation is explicit on both available and abstract-fallback paths', async () => {
  const longText = 'x'.repeat(MAX_TEXT_CHARS + 1000)
  const longHtml = `<html><body><div class="ltx_section"><h2 class="ltx_title ltx_title_section">1 Long</h2><div class="ltx_para"><p class="ltx_p">${longText}</p></div></div></body></html>`
  const client = createFakeClient({
    request: () => searchResponse([docAtmos], 1),
    requestExternal: () => htmlResponse(longHtml),
  })
  const tool = createReadPaperTool(makeDeps(client))
  const result = await tool.execute({ bibcode: docAtmos.bibcode }, makeExec())
  assert.equal(result.truncated, true)
  assert.equal(result.text.length, MAX_TEXT_CHARS)
  assert.ok(result.total_chars > MAX_TEXT_CHARS)

  const longAbstractDoc = { ...docNonArxiv, abstract: 'y'.repeat(MAX_TEXT_CHARS + 5) }
  const client2 = createFakeClient({ request: () => searchResponse([longAbstractDoc], 1) })
  const tool2 = createReadPaperTool(makeDeps(client2))
  const fallback = await tool2.execute({ bibcode: docNonArxiv.bibcode }, makeExec())
  assert.equal(fallback.truncated, true)
  assert.equal(fallback.text.length, MAX_TEXT_CHARS)
})

test('ABORTED propagates from external fetch and from a pre-aborted signal', async () => {
  const client = createFakeClient({
    request: () => searchResponse([docAtmos], 1),
    requestExternal: () => { throw scixError(ERROR_CODES.ABORTED, 'aborted') },
  })
  const tool = createReadPaperTool(makeDeps(client))
  await assert.rejects(tool.execute({ bibcode: docAtmos.bibcode }, makeExec()), (e) => e.code === 'ABORTED')

  const controller = new AbortController()
  controller.abort()
  const client2 = createFakeClient({ request: () => searchResponse([docAtmos], 1) })
  const tool2 = createReadPaperTool(makeDeps(client2))
  await assert.rejects(
    tool2.execute({ bibcode: docAtmos.bibcode }, makeExec({ signal: controller.signal })),
    (e) => e.code === 'ABORTED',
  )
  assert.equal(client2.calls.length, 1) // no external fetch after abort
})

test('TOKEN_MISSING propagates; unknown bibcode → API_ERROR 404; invalid arg → ToolArgsError', async () => {
  const missing = createFakeClient({ request: () => { throw scixError(ERROR_CODES.TOKEN_MISSING, 'no token') } })
  const tool = createReadPaperTool(makeDeps(missing))
  await assert.rejects(tool.execute({ bibcode: docAtmos.bibcode }, makeExec()), (e) => e.code === 'TOKEN_MISSING')

  const notFound = createFakeClient({ request: () => searchResponse([], 0) })
  const tool2 = createReadPaperTool(makeDeps(notFound))
  await assert.rejects(tool2.execute({ bibcode: docAtmos.bibcode }, makeExec()), (e) => e.code === 'API_ERROR' && e.status === 404)

  await assert.rejects(tool2.execute({ bibcode: 'bad bibcode' }, makeExec()), (e) => e.name === 'ToolArgsError')
})
