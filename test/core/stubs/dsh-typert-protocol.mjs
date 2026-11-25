/**
 * TEST STUB for '@deepseek-ai/dsh-typert-protocol' — mirrors ONLY the pieces
 * src/core/token.js uses, faithful to installed source (0.2.2-rc.5,
 * dsh-typert-protocol/src/index.ts, read 2026-11-25):
 * - bindTypertRemote (L236-247): frozen { service, serviceKey, namespace }
 *   binding; namespace defaults to serviceKey. (The Context.is/invocation
 *   accessor side effect needs cordis and is irrelevant to marker state.)
 * - Remote direct form (L300-317) + addMarkerInitializer (L428-444) + mark
 *   (L446-476): schedules an initializer that appends a frozen marker to the
 *   versioned descriptor at the STABLE prototype key (L224). Idempotent for
 *   identical markers; conflicting markers throw.
 * - remoteMethods (L404-408): detached snapshot read of that descriptor.
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

export function bindTypertRemote(service, serviceKey, options = {}) {
  const namespace = options.namespace ?? serviceKey
  return Object.freeze({ service, serviceKey, namespace })
}

export function Remote(method, context) {
  if (typeof method !== 'function' || context === undefined) {
    throw new TypeError('stub Remote: only the direct (method, context) form is supported')
  }
  if (context.private || context.static || typeof context.name !== 'string') {
    throw new TypeError('typert-protocol: Remote decorators require a public instance method with a string name')
  }
  const name = context.name
  context.addInitializer(function () {
    const prototype = Object.getPrototypeOf(this)
    if (prototype === null) {
      throw new TypeError(`typert-protocol: cannot mark Remote method "${name}" on an object without a prototype`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value
    const methods = descriptor?.methods ?? []
    const current = methods.find(candidate => candidate.method === name)
    if (current !== undefined) {
      if (current.invocation.kind === 'direct') return
      throw new Error(`typert-protocol: Remote method "${name}" has conflicting invocation markers`)
    }
    Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
      configurable: true,
      value: Object.freeze({
        version: 1,
        methods: Object.freeze([...methods, Object.freeze({
          method: name,
          invocation: Object.freeze({ kind: 'direct' }),
        })]),
      }),
    })
  })
}

export function remoteMethods(service) {
  const prototype = Object.getPrototypeOf(service)
  if (prototype === null) return []
  const descriptor = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)?.value
  return (descriptor?.methods ?? []).map(marker => ({ ...marker }))
}
