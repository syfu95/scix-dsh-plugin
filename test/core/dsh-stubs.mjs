/**
 * ESM resolve hook: redirect the two bare @deepseek-ai/* specifiers imported
 * by src/core/{errors,token}.js to faithful test stubs, so plain `node --test`
 * exercises the REAL plugin code without the DSH runtime. Every test file
 * that imports src/core modules registers this hook BEFORE the dynamic
 * import:
 *   import { register } from 'node:module'
 *   register('./dsh-stubs.mjs', import.meta.url)
 *   const { ... } = await import('../../src/core/client.js')
 * Stub fidelity is documented in each stub (installed sources read 2026-11-25).
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-error') {
    return { url: new URL('./stubs/dsh-error.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-typert-protocol') {
    return { url: new URL('./stubs/dsh-typert-protocol.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
