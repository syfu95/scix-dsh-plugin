/**
 * manage_library: biblib CRUD per api-brief §7 — exact paths/methods/bodies,
 * root-or-metadata response quirk, invalid_bibcodes surfaced verbatim,
 * action enum + id/bibcode validation, error propagation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { createManageLibraryTool, LIBRARY_ACTIONS } = await import('../../src/tools/manage-library.js')
const { createFakeClient, makeDeps, makeExec, scixError, ERROR_CODES, forbidRealNetwork } = await import('./helpers/fake-client.js')
const { validateToolOutput } = await import('./helpers/dsh-stub.js')
const { libraryMeta } = await import('./fixtures.js')
forbidRealNetwork()

const ID = libraryMeta.id
const BIBS = ['2021arXiv210301234X', '2020ApJ...890..123D']

function clientFor(handler) {
  return createFakeClient({ request: handler })
}

test('action vocabulary is exactly the seven CRUD operations', () => {
  assert.deepEqual([...LIBRARY_ACTIONS], ['list', 'create', 'get', 'update', 'delete', 'add_documents', 'remove_documents'])
})

test('list: GET biblib/libraries, metadata verbatim', async () => {
  const client = clientFor((path, options) => {
    assert.equal(path, '/biblib/libraries')
    assert.equal(options.method, undefined)
    return { count: 1, libraries: [libraryMeta] }
  })
  const tool = createManageLibraryTool(makeDeps(client))
  const result = await tool.execute({ action: 'list' }, makeExec())
  assert.deepEqual(validateToolOutput(tool, result), [])
  assert.equal(result.count, 1)
  assert.deepEqual(result.libraries, [libraryMeta])
})

test('create: POST biblib/libraries with name/public/bibcode; root metadata quirk', async () => {
  const client = clientFor((path, options) => {
    assert.equal(path, '/biblib/libraries')
    assert.equal(options.method, 'POST')
    assert.deepEqual(options.body, { name: 'My List', public: false, description: 'desc', bibcode: BIBS })
    return libraryMeta // root form
  })
  const tool = createManageLibraryTool(makeDeps(client))
  const result = await tool.execute({ action: 'create', name: 'My List', description: 'desc', bibcodes: BIBS }, makeExec())
  assert.equal(result.library_id, ID)
  assert.deepEqual(result.library, libraryMeta)
  assert.deepEqual(validateToolOutput(tool, result), [])
})

test('create: nested metadata form; public defaults false; name required', async () => {
  const client = clientFor((path, options) => {
    assert.deepEqual(options.body, { name: 'Public List', public: true })
    return { metadata: { ...libraryMeta, public: true } }
  })
  const tool = createManageLibraryTool(makeDeps(client))
  const result = await tool.execute({ action: 'create', name: 'Public List', public: true }, makeExec())
  assert.equal(result.library.public, true)
  const tool2 = createManageLibraryTool(makeDeps(clientFor(() => ({}))))
  await assert.rejects(tool2.execute({ action: 'create' }, makeExec()), (e) => e.name === 'ToolArgsError')
  await assert.rejects(tool2.execute({ action: 'create', name: '  ' }, makeExec()), (e) => e.name === 'ToolArgsError')
})

test('get: GET biblib/libraries/{id}, documents verbatim', async () => {
  const client = clientFor((path) => {
    assert.equal(path, `/biblib/libraries/${ID}`)
    return { metadata: libraryMeta, documents: BIBS }
  })
  const tool = createManageLibraryTool(makeDeps(client))
  const result = await tool.execute({ action: 'get', library_id: ID }, makeExec())
  assert.equal(result.library_id, ID)
  assert.deepEqual(result.documents, BIBS)
  assert.deepEqual(result.library, libraryMeta)
})

test('update: PUT biblib/documents/{id} (NOT libraries), only provided fields', async () => {
  const client = clientFor((path, options) => {
    assert.equal(path, `/biblib/documents/${ID}`)
    assert.equal(options.method, 'PUT')
    assert.deepEqual(options.body, { name: 'Renamed', public: true })
    return { name: 'Renamed', public: true }
  })
  const tool = createManageLibraryTool(makeDeps(client))
  const result = await tool.execute({ action: 'update', library_id: ID, name: 'Renamed', public: true }, makeExec())
  assert.deepEqual(result.updated, { name: 'Renamed', public: true })
  const tool2 = createManageLibraryTool(makeDeps(clientFor(() => ({}))))
  await assert.rejects(tool2.execute({ action: 'update', library_id: ID }, makeExec()), (e) => e.name === 'ToolArgsError')
})

test('delete: DELETE biblib/documents/{id} → deleted:true', async () => {
  const client = clientFor((path, options) => {
    assert.equal(path, `/biblib/documents/${ID}`)
    assert.equal(options.method, 'DELETE')
    return {}
  })
  const tool = createManageLibraryTool(makeDeps(client))
  const result = await tool.execute({ action: 'delete', library_id: ID }, makeExec())
  assert.equal(result.deleted, true)
  assert.equal(result.library_id, ID)
})

test('add/remove documents: POST action add|remove; invalid_bibcodes surfaced verbatim', async () => {
  const client = clientFor((path, options) => {
    assert.equal(path, `/biblib/documents/${ID}`)
    assert.equal(options.method, 'POST')
    assert.deepEqual(options.body, { bibcode: BIBS, action: 'add' })
    return { number_added: 1, invalid_bibcodes: ['2020ApJ...890..123D'] }
  })
  const tool = createManageLibraryTool(makeDeps(client))
  const result = await tool.execute({ action: 'add_documents', library_id: ID, bibcodes: BIBS }, makeExec())
  assert.equal(result.number_added, 1)
  assert.deepEqual(result.invalid_bibcodes, ['2020ApJ...890..123D'])
  assert.deepEqual(validateToolOutput(tool, result), [])

  const client2 = clientFor((path, options) => {
    assert.deepEqual(options.body, { bibcode: BIBS, action: 'remove' })
    return { number_removed: 2 }
  })
  const tool2 = createManageLibraryTool(makeDeps(client2))
  const removed = await tool2.execute({ action: 'remove_documents', library_id: ID, bibcodes: BIBS }, makeExec())
  assert.equal(removed.number_removed, 2)
  assert.deepEqual(removed.invalid_bibcodes, []) // absent in response → explicit []
})

test('validation: action enum, library_id shape (path injection), bibcodes requirements', async () => {
  const tool = createManageLibraryTool(makeDeps(clientFor(() => ({}))))
  for (const args of [
    { action: 'drop_table' },
    { action: 'get' },
    { action: 'get', library_id: '../etc' },
    { action: 'get', library_id: 'a/b' },
    { action: 'get', library_id: 'a?b' },
    { action: 'delete', library_id: '' },
    { action: 'add_documents', library_id: ID },
    { action: 'add_documents', library_id: ID, bibcodes: [] },
    { action: 'add_documents', library_id: ID, bibcodes: ['bad space'] },
    { action: 'remove_documents', library_id: ID, bibcodes: Array.from({ length: 2001 }, (_, i) => `B${i}`) },
    { action: 'create', name: 'x', bibcodes: ['bad space'] },
  ]) {
    await assert.rejects(tool.execute(args, makeExec()), (e) => e.name === 'ToolArgsError')
  }
})

test('API errors propagate with status (409 duplicate name, 410 gone, TOKEN_MISSING)', async () => {
  for (const [code, status] of [[ERROR_CODES.API_ERROR, 409], [ERROR_CODES.API_ERROR, 410], [ERROR_CODES.TOKEN_MISSING, undefined]]) {
    const client = clientFor(() => { throw scixError(code, 'fail', { status }) })
    const tool = createManageLibraryTool(makeDeps(client))
    await assert.rejects(tool.execute({ action: 'create', name: 'Dup' }, makeExec()), (error) => {
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      return true
    })
  }
})

test('exec.signal forwarded on every operation', async () => {
  const client = clientFor(() => ({ count: 0, libraries: [] }))
  const tool = createManageLibraryTool(makeDeps(client))
  const exec = makeExec()
  await tool.execute({ action: 'list' }, exec)
  assert.equal(client.calls[0].options.signal, exec.signal)
})
