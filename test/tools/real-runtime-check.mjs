/**
 * REAL-RUNTIME fidelity check (not part of the node --test gate).
 * Loads every tool factory through the INSTALLED @deepseek-ai/dsh-tools
 * defineTool (asar) so the real schema compiler validates all parameter and
 * output schemas. Run from the repo root with:
 *
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     test/tools/real-runtime-check.mjs
 *
 * Requires the DSH Desktop installation; plain node cannot resolve the asar
 * packages. Exits non-zero on any schema/compile failure.
 */
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PKGS = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai'

function entryUrl(spec) {
  const match = /^@deepseek-ai\/([^/]+)(\/.*)?$/.exec(spec)
  if (!match) throw new Error(`unmapped specifier: ${spec}`)
  const pkgDir = path.join(PKGS, match[1])
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const sub = match[2] ?? '.'
  let rel
  const exported = pj.exports?.[sub]
  if (exported) rel = typeof exported === 'string' ? exported : (exported.default ?? exported.import ?? exported.require)
  else if (sub === '.') rel = pj.main ?? 'index.js'
  else rel = sub
  if (!rel) throw new Error(`no entry for ${spec}`)
  return pathToFileURL(path.join(pkgDir, rel)).href
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: entryUrl(specifier), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { defineTool, ToolArgsError } = await import('@deepseek-ai/dsh-tools')
if (typeof defineTool !== 'function' || typeof ToolArgsError !== 'function') {
  throw new Error('installed dsh-tools did not expose defineTool/ToolArgsError')
}

const deps = {
  client: {
    request: async () => ({}),
    requestExternal: async () => ({ status: 200, headers: {}, text: '' }),
    dispose() {},
  },
  token: {},
  workingSets: {
    add: () => ({ working_set_id: 'ws-default', added: [], size: 0 }),
    set: () => ({ working_set_id: 'ws-default', size: 0 }),
    list: () => [],
    exclude: () => ({ working_set_id: 'ws-default', excluded: [], size: 0 }),
    get: () => undefined,
    dispose() {},
  },
  config: { apiBaseUrl: 'https://api.adsabs.harvard.edu/v1', requestTimeoutMs: 30000 },
}

const modules = [
  ['search', 'createSearchTool'],
  ['get-paper', 'createGetPaperTool'],
  ['read-paper', 'createReadPaperTool'],
  ['citation-traverse', 'createCitationTraverseTool'],
  ['forward-citations', 'createForwardCitationsTool'],
  ['find-gaps', 'createFindGapsTool'],
  ['export-citation', 'createExportCitationTool'],
  ['manage-library', 'createManageLibraryTool'],
]
for (const [file, factoryName] of modules) {
  const mod = await import(pathToFileURL(path.resolve(`src/tools/${file}.js`)).href)
  const definition = mod[factoryName](deps) // real defineTool compiles schemas here
  if (!definition.name || typeof definition.execute !== 'function') throw new Error(`bad definition: ${file}`)
  console.log(`REAL defineTool OK: ${definition.name}`)
}
console.log('All 8 tool definitions compile under installed dsh-tools 0.2.2-rc.5.')

// ---- Phase 2: real execute paths (real arg validation, real working-set store) ----
const { createWorkingSetStore } = await import(pathToFileURL(path.resolve('src/tools/working-set.js')).href)
const { createSearchTool } = await import(pathToFileURL(path.resolve('src/tools/search.js')).href)
const { createExportCitationTool } = await import(pathToFileURL(path.resolve('src/tools/export-citation.js')).href)
const { createCitationTraverseTool } = await import(pathToFileURL(path.resolve('src/tools/citation-traverse.js')).href)

const docA = { bibcode: '2021arXiv210301234X', title: ['A'], author: ['Smith, Jane'], year: '2021', citation_count: 42, identifier: ['arXiv:2103.01234'], esources: ['EPRINT_HTML'], property: ['EPRINT'] }
const docB = { bibcode: '2020ApJ...890..123D', title: ['B'], author: ['Roe, Richard'], year: '2020', citation_count: 10 }
const envelope = (docs) => ({ response: { numFound: docs.length, start: 0, docs } })
const liveDeps = {
  ...deps,
  client: {
    async request(path, options) {
      if (path === '/search/query') {
        return options.params.q.startsWith('similar(') ? envelope([docB, docA]) : envelope([docA, docB])
      }
      if (path === '/export/bibtex') return { export: '@ARTICLE{2021arXiv210301234X,\n  year = 2021\n}\n' }
      throw new Error(`unexpected path ${path}`)
    },
    async requestExternal() { return { status: 404, headers: {}, text: '' } },
    dispose() {},
  },
  workingSets: createWorkingSetStore(),
}
const exec = { callId: 'c1', rootCallId: 'c1', name: 'x', arguments: {}, agent: { id: 'real-check-session' }, token: Symbol('t'), signal: new AbortController().signal }

const searchResult = await createSearchTool(liveDeps).execute({ query: 'exoplanet atmospheres' }, exec)
if (searchResult.papers[0].bibcode !== docA.bibcode) throw new Error('real search fusion order wrong')
if (searchResult.fusion !== 'dual-path') throw new Error('real search fusion mode wrong')
if (liveDeps.workingSets.get('real-check-session').size !== 2) throw new Error('real working-set add failed')
console.log('REAL execute OK: search (RRF fusion + session working set)')

const exportText = await createExportCitationTool(liveDeps).execute({ bibcodes: [docA.bibcode], format: 'bibtex' }, exec)
if (exportText !== '@ARTICLE{2021arXiv210301234X,\n  year = 2021\n}\n') throw new Error('real export passthrough wrong')
console.log('REAL execute OK: export_citation (verbatim passthrough)')

try {
  await createCitationTraverseTool(liveDeps).execute({ bibcode: docA.bibcode, direction: 'sideways' }, exec)
  throw new Error('invalid direction was accepted')
} catch (error) {
  if (!(error instanceof ToolArgsError) || error.code !== 'INVALID_ARGS') throw error
  console.log('REAL validation OK: ToolArgsError(INVALID_ARGS) for bad enum')
}
console.log('Real-runtime fidelity check PASSED.')
