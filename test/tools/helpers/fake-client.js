/**
 * Fake ApiClient seam for tool tests (contracts/api-client.js shape plus the
 * agreed requestExternal). Records every call; handlers decide responses or
 * throw ScixError. Also installs a fetch guard proving tools never touch the
 * network directly. Self-bootstraps the DSH stubs so this file is safe even
 * if a runner executes it standalone.
 */
import { installDshStubs } from './stub-loader.js'
installDshStubs()
const { ScixError } = await import('../../../src/core/errors.js')
import { ERROR_CODES } from '../../../src/contracts/errors.js'
import { CONFIG_DEFAULTS } from '../../../src/contracts/config.js'
import { createWorkingSetStore } from '../../../src/tools/working-set.js'

/**
 * @param {{ request?: (path: string, options: object, index: number) => unknown,
 *           requestExternal?: (url: string, options: object, index: number) => unknown }} handlers
 */
export function createFakeClient(handlers = {}) {
  const calls = []
  let requestIndex = 0
  let externalIndex = 0
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ kind: 'request', path, options })
      if (!handlers.request) throw new Error(`unexpected client.request: ${path}`)
      return handlers.request(path, options, requestIndex++)
    },
    async requestExternal(url, options = {}) {
      calls.push({ kind: 'external', url, options })
      if (!handlers.requestExternal) throw new Error(`unexpected client.requestExternal: ${url}`)
      return handlers.requestExternal(url, options, externalIndex++)
    },
    dispose() {},
  }
}

/** Full ToolDeps with a fresh working-set store and stub token helpers. */
export function makeDeps(client) {
  return {
    client,
    token: {
      getToken: async () => 'test-token',
      setToken: async () => {},
      unsetToken: async () => {},
      verifyToken: async () => ({ ok: true, message: 'stub' }),
    },
    workingSets: createWorkingSetStore(),
    config: { ...CONFIG_DEFAULTS },
  }
}

/** Minimal ToolRunContext-shaped exec (identity fields per dev brief §4.3). */
export function makeExec({ sessionId = 'session-test', signal } = {}) {
  return {
    callId: 'call-1',
    rootCallId: 'call-1',
    name: 'test',
    arguments: {},
    agent: sessionId === null ? undefined : { id: sessionId },
    token: Symbol('exec-token'),
    signal: signal ?? new AbortController().signal,
  }
}

/** Standard ADS search response envelope. */
export function searchResponse(docs, numFound = docs.length) {
  return { responseHeader: { status: 0, QTime: 1 }, response: { numFound, start: 0, docs } }
}

/** Typed error factory matching src/core/errors.js semantics. */
export function scixError(code, message = code, options = {}) {
  return new ScixError(code, message, options)
}

export { ScixError, ERROR_CODES }

/** Prove no test path performs real network I/O. */
export function forbidRealNetwork() {
  globalThis.fetch = () => {
    throw new Error('real network access is forbidden in tool tests')
  }
}
