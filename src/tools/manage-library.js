/**
 * `manage_library` — SciX personal-library (biblib) CRUD per api-brief §7.
 * Actions: list / create / get / update / delete / add_documents /
 * remove_documents. Quirks honored: delete + metadata edit live on
 * `biblib/documents/{id}` (NOT libraries/{id}); create responses may carry
 * metadata at root OR under `metadata`; add/remove responses'
 * invalid_bibcodes are surfaced verbatim. Library ids are validated
 * (`[A-Za-z0-9_-]{1,64}`) and URL-encoded before path construction.
 * All ids/bibcodes in results are verbatim API values.
 * @module tools/manage-library
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { TOOL_NAMES } from '../contracts/tools.js'
import { isBibcode, isValidLibraryId, MAX_DOCUMENT_BATCH } from './bibcode.js'

/** Exact action vocabulary (hand-checked; DSL has no enum node per contract). */
export const LIBRARY_ACTIONS = Object.freeze([
  'list', 'create', 'get', 'update', 'delete', 'add_documents', 'remove_documents',
])

/**
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createManageLibraryTool(deps) {
  return defineTool({
    name: TOOL_NAMES.MANAGE_LIBRARY,
    description:
      "Manage the user's SciX personal libraries. Actions: 'list' (all libraries), 'create' " +
      "(needs name; optional description/public/bibcodes), 'get' (metadata + document bibcodes), " +
      "'update' (name/description/public), 'delete', 'add_documents' / 'remove_documents' " +
      '(need library_id + bibcodes; invalid_bibcodes from the API are reported verbatim). ' +
      'library_id is the verbatim id returned by list/create.',
    parameters: {
      action: { type: 'string', required: true, description: `Operation: ${LIBRARY_ACTIONS.join(' | ')}.` },
      library_id: { type: 'string', description: 'Verbatim SciX library id ([A-Za-z0-9_-]{1,64}); required for get/update/delete/add_documents/remove_documents.' },
      bibcodes: { type: 'array', items: { type: 'string' }, description: `Verbatim ADS bibcodes for create (optional seed documents) or add_documents/remove_documents (required, 1..${MAX_DOCUMENT_BATCH}).` },
      name: { type: 'string', description: 'Library name; required for create, optional for update.' },
      description: { type: 'string', description: 'Library description; optional for create/update.' },
      public: { type: 'boolean', description: 'Whether the library is public; optional for create (default false) / update.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          library_id: { type: 'string' },
          library: { type: 'json' },
          libraries: { type: 'array', items: { type: 'json' } },
          count: { type: 'integer' },
          documents: { type: 'array', items: { type: 'string' } },
          updated: { type: 'json' },
          deleted: { type: 'boolean' },
          number_added: { type: 'integer' },
          number_removed: { type: 'integer' },
          invalid_bibcodes: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const violations = []
      if (!LIBRARY_ACTIONS.includes(args.action)) {
        violations.push(`action must be one of: ${LIBRARY_ACTIONS.join(', ')}`)
      }
      const needsId = ['get', 'update', 'delete', 'add_documents', 'remove_documents'].includes(args.action)
      if (needsId && !isValidLibraryId(args.library_id)) {
        violations.push('library_id is required for this action and must match [A-Za-z0-9_-]{1,64} (verbatim from list/create)')
      }
      if (args.action === 'create' && (typeof args.name !== 'string' || args.name.trim().length === 0)) {
        violations.push('create requires a non-empty name')
      }
      if (args.action === 'update' && args.name === undefined && args.description === undefined && args.public === undefined) {
        violations.push('update requires at least one of name, description, public')
      }
      const needsBibcodes = ['add_documents', 'remove_documents'].includes(args.action)
      if (needsBibcodes) {
        if (!Array.isArray(args.bibcodes) || args.bibcodes.length === 0) {
          violations.push(`${args.action} requires a non-empty bibcodes array`)
        } else if (args.bibcodes.length > MAX_DOCUMENT_BATCH) {
          violations.push(`bibcodes exceeds the ${MAX_DOCUMENT_BATCH}-entry batch limit`)
        } else if (args.bibcodes.some((b) => !isBibcode(b))) {
          violations.push('bibcodes must all be verbatim ADS bibcode tokens')
        }
      }
      if (args.action === 'create' && args.bibcodes !== undefined) {
        if (!Array.isArray(args.bibcodes) || args.bibcodes.some((b) => !isBibcode(b))) {
          violations.push('bibcodes must be an array of verbatim ADS bibcode tokens')
        }
      }
      if (violations.length > 0) throw new ToolArgsError(violations)

      const signal = exec.signal
      const id = needsId ? encodeURIComponent(args.library_id) : ''

      switch (args.action) {
        case 'list': {
          const json = await deps.client.request('/biblib/libraries', { signal })
          return {
            action: 'list',
            count: typeof json?.count === 'number' ? json.count : Array.isArray(json?.libraries) ? json.libraries.length : 0,
            libraries: Array.isArray(json?.libraries) ? json.libraries : [],
          }
        }
        case 'create': {
          /** @type {Record<string, unknown>} */
          const body = { name: args.name, public: args.public ?? false }
          if (args.description !== undefined) body.description = args.description
          if (Array.isArray(args.bibcodes) && args.bibcodes.length > 0) body.bibcode = args.bibcodes
          const json = await deps.client.request('/biblib/libraries', { method: 'POST', body, signal })
          // Mutations may return metadata at root OR under `metadata`.
          const library = json?.metadata ?? json
          const libraryId = library && typeof library.id === 'string' ? library.id : undefined
          return {
            action: 'create',
            ...(libraryId !== undefined ? { library_id: libraryId } : {}),
            library,
          }
        }
        case 'get': {
          const json = await deps.client.request(`/biblib/libraries/${id}`, { signal })
          return {
            action: 'get',
            library_id: args.library_id,
            library: json?.metadata ?? null,
            documents: Array.isArray(json?.documents) ? json.documents.filter((d) => typeof d === 'string') : [],
          }
        }
        case 'update': {
          /** @type {Record<string, unknown>} */
          const body = {}
          if (args.name !== undefined) body.name = args.name
          if (args.description !== undefined) body.description = args.description
          if (args.public !== undefined) body.public = args.public
          const json = await deps.client.request(`/biblib/documents/${id}`, { method: 'PUT', body, signal })
          return { action: 'update', library_id: args.library_id, updated: json ?? {} }
        }
        case 'delete': {
          await deps.client.request(`/biblib/documents/${id}`, { method: 'DELETE', signal })
          return { action: 'delete', library_id: args.library_id, deleted: true }
        }
        default: {
          // add_documents / remove_documents
          const apiAction = args.action === 'add_documents' ? 'add' : 'remove'
          const json = await deps.client.request(`/biblib/documents/${id}`, {
            method: 'POST',
            body: { bibcode: args.bibcodes, action: apiAction },
            signal,
          })
          return {
            action: args.action,
            library_id: args.library_id,
            ...(typeof json?.number_added === 'number' ? { number_added: json.number_added } : {}),
            ...(typeof json?.number_removed === 'number' ? { number_removed: json.number_removed } : {}),
            invalid_bibcodes: Array.isArray(json?.invalid_bibcodes)
              ? json.invalid_bibcodes.filter((b) => typeof b === 'string')
              : [],
          }
        }
      }
    },
  })
}
