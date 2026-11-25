/**
 * `export_citation` — DETERMINISTIC bibliography export (Agent.md §2.4,
 * api-brief §9). POST export/{bibtex|aastex|ris} with the verbatim bibcode
 * list; the API produces the text server-side and this tool returns
 * response.export VERBATIM (output root: string). ZERO model-side field
 * invention: no author/year/DOI mapping happens in the plugin at all.
 * No `sort` is sent, so the server default (date then bibcode) makes the
 * output independent of input order.
 * @module tools/export-citation
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ScixError } from '../core/errors.js'
import { TOOL_NAMES } from '../contracts/tools.js'
import { ERROR_CODES } from '../contracts/errors.js'
import { isBibcode, MAX_DOCUMENT_BATCH } from './bibcode.js'

/** Supported export formats (all confirmed in spec + notebook, api-brief §9). */
export const EXPORT_FORMATS = Object.freeze(['bibtex', 'aastex', 'ris'])

/**
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createExportCitationTool(deps) {
  return defineTool({
    name: TOOL_NAMES.EXPORT_CITATION,
    description:
      'Export bibliography entries for verbatim ADS bibcodes in BibTeX, AASTeX, or RIS. The text ' +
      'is generated server-side by the ADS export endpoint and returned verbatim — fields are ' +
      'never model-completed. Same bibcodes + format always yield the same text (server default ' +
      'sort: date then bibcode).',
    parameters: {
      bibcodes: { type: 'array', items: { type: 'string' }, required: true, description: `Verbatim ADS bibcodes to export (1..${MAX_DOCUMENT_BATCH}; exact duplicates removed, order otherwise preserved).` },
      format: { type: 'string', required: true, description: "Export format: 'bibtex', 'aastex', or 'ris'." },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const violations = []
      if (!EXPORT_FORMATS.includes(args.format)) {
        violations.push(`format must be one of: ${EXPORT_FORMATS.join(', ')}`)
      }
      if (!Array.isArray(args.bibcodes) || args.bibcodes.length === 0) {
        violations.push('bibcodes must be a non-empty array of verbatim ADS bibcodes')
      } else {
        if (args.bibcodes.length > MAX_DOCUMENT_BATCH) {
          violations.push(`bibcodes exceeds the ${MAX_DOCUMENT_BATCH}-entry batch limit`)
        }
        for (const bibcode of args.bibcodes) {
          if (!isBibcode(bibcode)) {
            violations.push(`invalid bibcode: ${JSON.stringify(bibcode)} (must be a verbatim ADS bibcode token)`)
            break
          }
        }
      }
      if (violations.length > 0) throw new ToolArgsError(violations)

      // Dedupe exact duplicates, preserve first-occurrence order (deterministic).
      const seen = new Set()
      const bibcodes = args.bibcodes.filter((b) => (seen.has(b) ? false : (seen.add(b), true)))

      const json = await deps.client.request(`/export/${args.format}`, {
        method: 'POST',
        body: { bibcode: bibcodes },
        signal: exec.signal,
      })
      if (!json || typeof json.export !== 'string') {
        throw new ScixError(
          ERROR_CODES.API_ERROR,
          `The ADS export/${args.format} endpoint returned no export text. Nothing was generated client-side.`,
        )
      }
      return json.export
    },
  })
}
