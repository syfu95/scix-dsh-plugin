/**
 * Resolve-hook installer: maps the two bare DSH specifiers used by
 * src/tools/** (and src/core/errors.js) to the local test doubles, so plain
 * `node --test test/tools/` loads the real tool modules without the DSH
 * runtime. Uses node:module registerHooks (synchronous, node >= 22.15).
 * Production code is untouched: it keeps importing the real package names.
 */
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const SPECIFIER_MAP = new Map([
  ['@deepseek-ai/dsh-tools', new URL('./dsh-tools-stub.js', import.meta.url).href],
  ['@deepseek-ai/dsh-error', new URL('./dsh-error-stub.js', import.meta.url).href],
])

let installed = false

/** Idempotent; call before dynamically importing any src/tools module. */
export function installDshStubs() {
  if (installed) return
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const mapped = SPECIFIER_MAP.get(specifier)
      if (mapped) return { url: mapped, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
  installed = true
}

export { fileURLToPath }
