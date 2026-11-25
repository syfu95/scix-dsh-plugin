/**
 * registerAllTools wiring: all eight stable tool names registered through
 * ctx.tools.register; combined disposer unregisters in reverse order.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installDshStubs } from './helpers/stub-loader.js'
installDshStubs()
const { registerAllTools } = await import('../../src/tools/index.js')
const { TOOL_NAMES } = await import('../../src/contracts/tools.js')
const { createFakeClient, makeDeps, forbidRealNetwork } = await import('./helpers/fake-client.js')
forbidRealNetwork()

test('registers exactly the eight contract tools and disposes in reverse order', () => {
  const registered = []
  const disposed = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition.name)
        return () => disposed.push(definition.name)
      },
    },
  }
  const deps = makeDeps(createFakeClient({}))
  const dispose = registerAllTools(ctx, deps)
  assert.deepEqual(registered, [
    TOOL_NAMES.SEARCH, TOOL_NAMES.GET_PAPER, TOOL_NAMES.READ_PAPER,
    TOOL_NAMES.CITATION_TRAVERSE, TOOL_NAMES.FORWARD_CITATIONS,
    TOOL_NAMES.FIND_GAPS, TOOL_NAMES.EXPORT_CITATION, TOOL_NAMES.MANAGE_LIBRARY,
  ])
  assert.equal(registered.length, 8)
  dispose()
  assert.deepEqual(disposed, [...registered].reverse())
})

test('every registered definition carries a compiled parameter schema and output render', () => {
  const definitions = []
  const ctx = { tools: { register: (d) => { definitions.push(d); return () => {} } } }
  registerAllTools(ctx, makeDeps(createFakeClient({})))
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.ok(definition.output.schema)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }
})
