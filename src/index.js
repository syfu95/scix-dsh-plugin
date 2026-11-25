/**
 * Host entry for scix-dsh-plugin (function form, dev brief §4.1).
 * Wires the queued API client, credential-backed token helpers, the
 * session working-set store, all eight tools, and the verify Remote endpoint.
 * Every resource is registered inside one ctx.effect and cleaned up on unload
 * (brief §4.4); config edits hot-replace the plugin through the same path.
 * @module scix-dsh-plugin
 */
import Schema from '@deepseek-ai/schemastery'
import { CONFIG_DEFAULTS } from './contracts/config.js'
import { createApiClient } from './core/client.js'
import { getToken, setToken, unsetToken, verifyToken, registerVerifyRemote } from './core/token.js'
import { createWorkingSetStore } from './tools/working-set.js'
import { registerAllTools } from './tools/index.js'

/** Wait for the tool registry and the credential store (brief §4.3, §4.5). */
export const inject = ['tools', 'credentials']

/**
 * Non-secret settings only; the ADS token is a credential, never config.
 * Schemastery schema — a plain object export is rejected by Cordis (brief §4.2).
 */
export const Config = Schema.object({
  apiBaseUrl: Schema.string().default(CONFIG_DEFAULTS.apiBaseUrl),
  requestTimeoutMs: Schema.number().default(CONFIG_DEFAULTS.requestTimeoutMs),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./contracts/config.js').PluginConfig} config
 */
export function apply(ctx, config) {
  ctx.effect(() => {
    const client = createApiClient(ctx, config)
    const workingSets = createWorkingSetStore()
    /** @type {import('./contracts/token.js').TokenHelpers} */
    const token = {
      getToken: () => getToken(ctx),
      setToken: (value) => setToken(ctx, value),
      unsetToken: () => unsetToken(ctx),
      // apiBaseUrl wired through so verify probes the CONFIGURED host (SciX or ADS).
      verifyToken: (options) => verifyToken(ctx, { apiBaseUrl: config.apiBaseUrl, ...options }),
    }
    const disposeTools = registerAllTools(ctx, { client, token, workingSets, config })
    const disposeRemote = registerVerifyRemote(ctx, config)
    // Unload cleanup: tools first, then remote, store, and finally the queue —
    // client.dispose() must leave no dangling network requests (Agent.md §5).
    return () => {
      disposeTools()
      disposeRemote()
      workingSets.dispose()
      client.dispose()
    }
  })
}