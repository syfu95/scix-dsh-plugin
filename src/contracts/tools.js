/**
 * Tool surface + result conventions (Agent.md §4). Tool names and parameter
 * names are STABLE contract — do not rename or add aliases; models must not
 * hallucinate fields from similar APIs.
 * @module contracts/tools
 */

/** The eight registered tool names (exact, stable). */
export const TOOL_NAMES = Object.freeze({
  SEARCH: 'search',
  GET_PAPER: 'get_paper',
  READ_PAPER: 'read_paper',
  CITATION_TRAVERSE: 'citation_traverse',
  FORWARD_CITATIONS: 'forward_citations',
  FIND_GAPS: 'find_gaps',
  EXPORT_CITATION: 'export_citation',
  MANAGE_LIBRARY: 'manage_library',
})

/**
 * Result conventions — every tool MUST honor these:
 * 1. Identifiers VERBATIM: bibcode, DOI, arXiv id, and library ids are copied
 *    byte-for-byte from the API response. No model-side rewriting, trimming,
 *    normalization, or "recall".
 * 2. body_available is ALWAYS an explicit boolean on any result describing a
 *    paper (true only when body text is actually retrievable via the API).
 *    When false, say so explicitly — never silently skip or fabricate content.
 * 3. No PDF bytes, no PDF download links in any result (Agent.md §2.1).
 *    read_paper returns API text only.
 * 4. export_citation is DETERMINISTIC: author/year/DOI/bibcode fields map
 *    directly from API data; never model-completed (Agent.md §2.4).
 * 5. Mark omissions/truncation explicitly (e.g. truncated:true, total_count)
 *    per the brief's tool-design rules; prefer bounded outputs with identifiers.
 * 6. execute returns ONLY the canonical JSON value declared by output.schema;
 *    render() produces model-facing text. Honor exec.signal; pass it to client.request.
 * 7. Expected failures throw ScixError with ERROR_CODES (see contracts/errors.js).
 */

/**
 * Minimal paper reference stored in working sets and returned by list tools.
 * @typedef {Object} PaperRef
 * @property {string} bibcode Verbatim ADS bibcode (required).
 * @property {string} [title] Verbatim API title.
 * @property {string[]} [author] Verbatim API author list.
 * @property {number} [year] API publication year.
 */

/**
 * Dependency bundle passed to every tool factory and registerAllTools.
 * @typedef {Object} ToolDeps
 * @property {import('./api-client.js').ApiClient} client
 * @property {import('./token.js').TokenHelpers} token
 * @property {import('./working-set.js').WorkingSetStore} workingSets
 * @property {import('./config.js').PluginConfig} config
 */

/**
 * Factory contract: each src/tools/<name>.js exports
 * `create<Name>Tool(deps: ToolDeps) → ToolDefinition` built with
 * `defineTool` imported from '@deepseek-ai/dsh-tools' (brief §4.3).
 * Registration happens ONLY in src/tools/index.js via ctx.tools.register,
 * whose disposer is returned to the entry's ctx.effect.
 *
 * Session scoping: tools derive a stable per-conversation sessionKey from the
 * execution context and pass it to workingSets. TODO(implementers): verify the
 * exact exec/session field in the installed dsh sources before relying on it —
 * do not invent one (exec identity fields are listed in brief §4.3).
 */