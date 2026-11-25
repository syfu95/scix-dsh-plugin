/**
 * TEST-ONLY doubles for '@deepseek-ai/dsh-tools' and '@deepseek-ai/dsh-error'.
 * Mirrors the INSTALLED dsh-tools 0.2.2-rc.5 src/schema.ts rules (read
 * 2026-11-25): author-key whitelist, mandatory object additionalProperties,
 * required:true-only annotation, items/oneOf/enum/const support, args
 * validated BEFORE execute with ToolArgsError(violations: string[])
 * (code INVALID_ARGS). HarnessError mirrors constructor(message, code,
 * options?) with name = subclass constructor name.
 *
 * These doubles let `node --test` load src/tools/*.js in plain node; the
 * production modules keep importing the real package names.
 */

export class HarnessError extends Error {
  constructor(message, code, options = {}) {
    super(message, { cause: options?.cause })
    this.name = new.target.name
    this.code = code
  }
}

export class ToolArgsError extends HarnessError {
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

function authorError(message) {
  throw new Error(`schema: ${message}`)
}

function assertAuthorKeys(source, path, allowed) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

/** Compile one author node (mirrors runSchemaCompiler's validation rules). */
function compileValue(input, path, allowRequired) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) authorError(`${path} must be a value schema object`)
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]
  if (Object.hasOwn(input, 'required') && input.required !== true) authorError(`${path}.required must be true when present`)
  const node = {}
  for (const key of ANNOTATION_KEYS) if (Object.hasOwn(input, key)) node[key] = input[key]
  if (Object.hasOwn(input, 'oneOf')) {
    assertAuthorKeys(input, path, [...authorKeys, 'oneOf', 'type'])
    if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) authorError(`${path}.oneOf must be an array of at least two value schemas`)
    node.oneOf = input.oneOf.map((branch, i) => compileValue(branch, `${path}.oneOf[${i}]`, false))
    return node
  }
  switch (input.type) {
    case 'json':
      assertAuthorKeys(input, path, [...authorKeys, 'type'])
      node.type = 'json'
      return node
    case 'object':
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
      if (typeof input.additionalProperties !== 'boolean') authorError(`${path}.additionalProperties must be explicitly true or false`)
      node.type = 'object'
      node.additionalProperties = input.additionalProperties
      if (Object.hasOwn(input, 'properties')) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`)
        node.properties = compiled.properties
        if (compiled.required.length > 0) node.required = compiled.required
      }
      return node
    case 'array':
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
      node.type = 'array'
      if (Object.hasOwn(input, 'items')) node.items = compileValue(input.items, `${path}.items`, false)
      return node
    default:
      if (!SCALAR_TYPES.includes(input.type)) authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
      node.type = input.type
      if (Object.hasOwn(input, 'enum')) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) authorError(`${path}.enum must be a non-empty array`)
        node.enum = [...input.enum]
      }
      if (Object.hasOwn(input, 'const')) node.const = input.const
      return node
  }
}

function compilePropertyMap(input, path) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) authorError(`${path} must be an object of value schemas`)
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(input)) {
    if (spec && typeof spec === 'object' && Object.hasOwn(spec, 'required') && spec.required === true) required.push(key)
    properties[key] = compileValue(spec, `${path}.${key}`, true)
  }
  return { properties, required }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Lossless-JSON check (mirrors the registry's snapshot requirement). */
export function assertLosslessJson(value, path = 'value') {
  if (value === null) return
  const t = typeof value
  if (t === 'string' || t === 'boolean') return
  if (t === 'number') {
    if (!Number.isFinite(value)) authorError(`${path} must be a finite number`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertLosslessJson(item, `${path}[${i}]`))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${path}.${key}`)
    return
  }
  authorError(`${path} is not lossless JSON (${t})`)
}

/** Validate a value against a compiled node; returns violation strings. */
export function validateValue(node, value, path) {
  const violations = []
  if (node.oneOf) {
    const matches = node.oneOf.filter((branch) => validateValue(branch, value, path).length === 0)
    if (matches.length !== 1) violations.push(`${path}: must match exactly one oneOf branch`)
    return violations
  }
  switch (node.type) {
    case 'json':
      try { assertLosslessJson(value, path) } catch (error) { violations.push(error.message) }
      return violations
    case 'string':
      if (typeof value !== 'string') violations.push(`${path}: expected string`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path}: expected finite number`)
      break
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${path}: expected integer`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path}: expected boolean`)
      break
    case 'null':
      if (value !== null) violations.push(`${path}: expected null`)
      break
    case 'array':
      if (!Array.isArray(value)) {
        violations.push(`${path}: expected array`)
      } else if (node.items) {
        value.forEach((item, i) => violations.push(...validateValue(node.items, item, `${path}[${i}]`)))
      }
      break
    case 'object':
      if (!isPlainObject(value)) {
        violations.push(`${path}: expected object`)
        break
      }
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(value, key)) violations.push(`${path}.${key}: required`)
      }
      for (const [key, spec] of Object.entries(node.properties ?? {})) {
        if (Object.hasOwn(value, key)) violations.push(...validateValue(spec, value[key], `${path}.${key}`))
      }
      if (node.additionalProperties === false) {
        const declared = new Set(Object.keys(node.properties ?? {}))
        for (const key of Object.keys(value)) {
          if (!declared.has(key)) violations.push(`${path}.${key}: additional property not allowed`)
        }
      }
      break
    default:
      violations.push(`${path}: unknown schema node`)
  }
  if (node.enum && !node.enum.includes(value)) violations.push(`${path}: must be one of ${JSON.stringify(node.enum)}`)
  if (Object.hasOwn(node, 'const') && value !== node.const) violations.push(`${path}: must equal const`)
  return violations
}

/** Mirror of defineTool: compile schemas, validate args before execute. */
export function defineTool(options) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = compilePropertyMap(options.parameters, 'parameters')
  const parameterSchema = {
    type: 'object',
    properties: parameters.properties,
    ...(parameters.required.length > 0 ? { required: parameters.required } : {}),
    additionalProperties: true, // implicit parameter root stays open
  }
  const outputSchema = compileValue(options.output.schema, 'schema', false)
  const userExecute = options.execute
  const userRender = options.output.render
  return {
    name: options.name,
    description: options.description,
    parameters: parameterSchema,
    output: {
      schema: outputSchema,
      render: (args, value) => userRender(args, value),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args, exec) {
      const violations = validateValue(parameterSchema, args, 'args')
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args, exec)
    },
  }
}

/** Test helper: validate a canonical output value against a tool's schema. */
export function validateToolOutput(tool, value) {
  assertLosslessJson(value)
  return validateValue(tool.output.schema, value, 'output')
}
