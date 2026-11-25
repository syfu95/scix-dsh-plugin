/**
 * Plugin Config contract: MINIMAL non-secret settings only (dev brief §4.2).
 * The ADS token is NEVER a config field — it is a credential (contracts/token.js).
 * The Schemastery schema is built in src/index.js as `Schema.object({...})`
 * (a plain object export is rejected by Cordis); defaults below are the single
 * source of truth shared by schema, client, and tests.
 * @module contracts/config
 */

/**
 * @typedef {Object} PluginConfig
 * @property {string} apiBaseUrl ADS API root; request paths are relative to it.
 * @property {number} requestTimeoutMs Per-request timeout in milliseconds.
 */

/** Schema defaults (also the documented deployment defaults). */
export const CONFIG_DEFAULTS = Object.freeze({
  apiBaseUrl: 'https://api.adsabs.harvard.edu/v1',
  requestTimeoutMs: 30000,
})

/**
 * Schema shape to build in src/index.js (Schemastery, per brief §4.2):
 *   Schema.object({
 *     apiBaseUrl: Schema.string().default(CONFIG_DEFAULTS.apiBaseUrl),
 *     requestTimeoutMs: Schema.number().default(CONFIG_DEFAULTS.requestTimeoutMs),
 *   })
 * Anything two deployments may set differently belongs here, not in code.
 */