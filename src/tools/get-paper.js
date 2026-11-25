/**
 * `get_paper` — full metadata for one bibcode via q=bibcode:"…" with a broad
 * fl (api-brief §2). body_available is a SIGNAL-BASED ESTIMATE (api-brief
 * §5/§9: esources/property/fulltext_mtime + arXiv-route availability); only
 * read_paper confirms retrieval. Identifiers verbatim; never PDF links.
 *
 * Defensive fallback (api-brief §11.1): `uat` is absent from the OpenAPI fl
 * enum; on API_ERROR status 400 we retry ONCE without uat (keyword_norm is
 * already requested as the controlled-keyword fallback) and note it.
 * @module tools/get-paper
 */
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { ScixError } from '../core/errors.js'
import { TOOL_NAMES } from '../contracts/tools.js'
import { ERROR_CODES } from '../contracts/errors.js'
import { sessionKeyFromExec } from './session.js'
import { isBibcode, escapeSolrPhrase } from './bibcode.js'
import { GET_PAPER_FL, firstTitle, toYear, detectBodyAvailability, mapPaperRef, BODY_ESTIMATE_NOTE } from './paper-map.js'

/**
 * @param {import('../contracts/tools.js').ToolDeps} deps
 * @returns {import('@deepseek-ai/dsh-tools').ToolDefinition}
 */
export function createGetPaperTool(deps) {
  return defineTool({
    name: TOOL_NAMES.GET_PAPER,
    description:
      'Fetch full metadata for one paper by its verbatim ADS bibcode: title, authors, year, ' +
      'abstract, citation/read counts, DOI, identifiers, arXiv class, UAT concepts, and a ' +
      'signal-based body_available estimate (confirmed only by read_paper). Never returns PDF ' +
      'files or download links. Adds the paper to the session working set.',
    parameters: {
      bibcode: { type: 'string', required: true, description: 'Verbatim ADS bibcode (19 characters, exactly as returned by search).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          bibcode: { type: 'string' },
          title: { type: 'string' },
          first_author: { type: 'string' },
          author: { type: 'array', items: { type: 'string' } },
          year: { type: 'integer' },
          pubdate: { type: 'string' },
          pub: { type: 'string' },
          volume: { type: 'string' },
          page: { type: 'array', items: { type: 'string' } },
          issue: { type: 'string' },
          abstract: { type: 'string' },
          citation_count: { type: 'integer' },
          read_count: { type: 'integer' },
          doi: { type: 'array', items: { type: 'string' } },
          identifier: { type: 'array', items: { type: 'string' } },
          eid: { type: 'string' },
          alternate_bibcode: { type: 'array', items: { type: 'string' } },
          keyword: { type: 'array', items: { type: 'string' } },
          keyword_norm: { type: 'array', items: { type: 'string' } },
          uat: { type: 'array', items: { type: 'string' } },
          aff: { type: 'array', items: { type: 'string' } },
          doctype: { type: 'string' },
          arxiv_class: { type: 'array', items: { type: 'string' } },
          property: { type: 'array', items: { type: 'string' } },
          esources: { type: 'array', items: { type: 'string' } },
          fulltext_mtime: { type: 'string' },
          arxiv_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          arxiv_id_source: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          body_available: { type: 'boolean' },
          body_available_reason: { type: 'string' },
          body_available_note: { type: 'string' },
          field_note: { type: 'string' },
          working_set_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      if (!isBibcode(args.bibcode)) {
        throw new ToolArgsError(['bibcode must be a verbatim ADS bibcode token (letters/digits/.&:_-, no spaces or quotes)'])
      }
      const q = `bibcode:"${escapeSolrPhrase(args.bibcode)}"`
      let json
      let fieldNote
      try {
        json = await deps.client.request('/search/query', {
          params: { q, rows: 1, fl: GET_PAPER_FL },
          signal: exec.signal,
        })
      } catch (error) {
        // api-brief §11.1: uat may be rejected in fl; retry once without it.
        if (error instanceof ScixError && error.code === ERROR_CODES.API_ERROR && error.status === 400) {
          json = await deps.client.request('/search/query', {
            params: { q, rows: 1, fl: GET_PAPER_FL.split(',').filter((f) => f !== 'uat').join(',') },
            signal: exec.signal,
          })
          fieldNote = 'The ADS API rejected fl=uat (HTTP 400); retried without it. keyword_norm carries controlled keywords as fallback.'
        } else {
          throw error
        }
      }
      const doc = json?.response?.docs?.[0]
      if (!doc || typeof doc.bibcode !== 'string') {
        throw new ScixError(
          ERROR_CODES.API_ERROR,
          `No ADS record found for bibcode "${args.bibcode}". Use a bibcode verbatim from search results.`,
          { status: 404 },
        )
      }

      /** @type {Record<string, unknown>} */
      const result = { bibcode: doc.bibcode }
      const title = firstTitle(doc)
      if (title !== undefined) result.title = title
      copyString(doc, result, 'first_author')
      copyStringArray(doc, result, 'author')
      const year = toYear(doc)
      if (year !== undefined) result.year = year
      copyString(doc, result, 'pubdate')
      copyString(doc, result, 'pub')
      copyString(doc, result, 'volume')
      copyStringArray(doc, result, 'page')
      copyString(doc, result, 'issue')
      copyString(doc, result, 'abstract')
      copyNumber(doc, result, 'citation_count')
      copyNumber(doc, result, 'read_count')
      copyStringArray(doc, result, 'doi')
      copyStringArray(doc, result, 'identifier')
      copyString(doc, result, 'eid')
      copyStringArray(doc, result, 'alternate_bibcode')
      copyStringArray(doc, result, 'keyword')
      copyStringArray(doc, result, 'keyword_norm')
      copyStringArray(doc, result, 'uat')
      copyStringArray(doc, result, 'aff')
      copyString(doc, result, 'doctype')
      copyStringArray(doc, result, 'arxiv_class')
      copyStringArray(doc, result, 'property')
      copyStringArray(doc, result, 'esources')
      copyString(doc, result, 'fulltext_mtime')

      const body = detectBodyAvailability(doc)
      result.arxiv_id = body.arxiv_id
      result.arxiv_id_source = body.arxiv_id_source
      result.body_available = body.available
      result.body_available_reason = body.reason
      result.body_available_note = BODY_ESTIMATE_NOTE
      if (fieldNote !== undefined) result.field_note = fieldNote

      const added = deps.workingSets.add(sessionKeyFromExec(exec), [mapPaperRef(doc)])
      result.working_set_id = added.working_set_id
      return result
    },
  })
}

/** @param {Record<string, unknown>} doc @param {Record<string, unknown>} out @param {string} field */
function copyString(doc, out, field) {
  if (typeof doc[field] === 'string') out[field] = doc[field]
}
/** @param {Record<string, unknown>} doc @param {Record<string, unknown>} out @param {string} field */
function copyStringArray(doc, out, field) {
  if (Array.isArray(doc[field])) {
    const values = doc[field].filter((v) => typeof v === 'string')
    if (values.length > 0) out[field] = values
  }
}
/** @param {Record<string, unknown>} doc @param {Record<string, unknown>} out @param {string} field */
function copyNumber(doc, out, field) {
  if (typeof doc[field] === 'number' && Number.isFinite(doc[field])) out[field] = doc[field]
}
