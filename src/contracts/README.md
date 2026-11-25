# SciX plugin — interface contracts & module export map

Authoritative wiring reference for implementers. Sources: `.plan/dsh-dev-brief.md`
(installed-DSH facts) and `Agent.md` (product spec). Constants here are the single
source of truth; do not duplicate their values elsewhere.

## Module export map (file → named exports → signatures)

| File | Named exports | Signature / shape |
|---|---|---|
| `src/index.js` | `inject` | `['tools', 'credentials']` |
| | `Config` | Schemastery `Schema.object({ apiBaseUrl, requestTimeoutMs })` |
| | `apply` | `apply(ctx, config) → void`; all wiring inside one `ctx.effect` |
| `src/core/client.js` | `createApiClient` | `(ctx, config, seam?) → ApiClient` (`request(path, { method, params, body, signal, headers? }) → Promise<json>`, `dispose()`); `seam` = optional test-only fetch seam; `RequestOptions` gained optional `headers` |
| | `requestExternal` | `(url, { method, signal, accept, headers }) → Promise<{ status, headers, text }>`; per-host 1000ms lanes, ≤2 retries on 429/503, no auth header, no ADS quota, PDF guard incl. redirects, throws ABORTED on abort |
| `src/core/token.js` | `getToken` | `(ctx) → Promise<string\|undefined>` |
| | `setToken` | `(ctx, value) → Promise<void>` |
| | `unsetToken` | `(ctx) → Promise<void>` |
| | `verifyToken` | `(ctx, { signal?, apiBaseUrl? } = {}) → Promise<TokenVerification>`; RESOLVES `{ ok:false, message }` on 401/403 and network failure — only abort throws |
| | `registerVerifyRemote` | `(ctx, config = {}) → () => void` (disposer; TypertRemoteService `scixController` / ns `scix` / method `verifyToken`) |
| `src/core/errors.js` | `ScixError` | `new ScixError(code, message, { status?, retryAfterMs?, cause? })`; extends `HarnessError` from `@deepseek-ai/dsh-error` |
| `src/tools/index.js` | `registerAllTools` | `(ctx, deps: ToolDeps) → () => void` (combined disposer of all 8 `ctx.tools.register` calls) |
| `src/tools/working-set.js` | `createWorkingSetStore` | `() → WorkingSetStore` (`add/set/list/exclude/get/dispose`, session-scoped) |
| `src/tools/search.js` | `createSearchTool` | `(deps: ToolDeps) → ToolDefinition` via `defineTool` |
| `src/tools/get-paper.js` | `createGetPaperTool` | same |
| `src/tools/read-paper.js` | `createReadPaperTool` | same |
| `src/tools/citation-traverse.js` | `createCitationTraverseTool` | same |
| `src/tools/forward-citations.js` | `createForwardCitationsTool` | same |
| `src/tools/find-gaps.js` | `createFindGapsTool` | same |
| `src/tools/export-citation.js` | `createExportCitationTool` | same (output root: string) |
| `src/tools/manage-library.js` | `createManageLibraryTool` | same |
| `src/contracts/index.js` | barrel | re-exports all contract modules below |
| `src/contracts/errors.js` | `ERROR_CODES`, `TOKEN_MISSING_MESSAGE` | frozen code map; actionable message |
| `src/contracts/api-client.js` | `BURST_LIMIT_PER_SECOND` (15), `DAILY_REQUEST_QUOTA` (3000), `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `MAX_429_RETRIES` | queue constants + `ApiClient`/`RequestOptions` typedefs |
| `src/contracts/token.js` | `TOKEN_CREDENTIAL_REF` (`SCIX_API_TOKEN`), `TOKEN_RECORD_OWNER`, `TOKEN_RECORD_ID`, `REMOTE_SERVICE_NAME` (`scixController`), `REMOTE_NAMESPACE` (`scix`), `REMOTE_VERIFY_METHOD` (`verifyToken`) | credential + remote constants; `TokenHelpers`/`TokenVerification` typedefs |
| `src/contracts/tools.js` | `TOOL_NAMES` | frozen 8-name map; `PaperRef`/`ToolDeps` typedefs; result conventions |
| `src/contracts/working-set.js` | `WORKING_SET_ID_PREFIX` (`ws-`), `DEFAULT_WORKING_SET_ID` (`ws-default`) | `WorkingSetStore`/`WorkingSet`/`WorkingSetSummary` typedefs |
| `src/contracts/config.js` | `CONFIG_DEFAULTS` | `{ apiBaseUrl, requestTimeoutMs }`; `PluginConfig` typedef |
| `src/contracts/ui.js` | `PACKAGE_NAME`, `ROW_ID`, `SLOT_BUNDLE_CONFIG`, `BUNDLE_CONFIG_KEY`, `SLOT_ROW_CONFIG`, `ROW_CONFIG_KEY` | slot keys: `scix-dsh-plugin` / `scix-dsh-plugin#scix` |

Other agents own: `client/index.js` (Client half; factory id MUST equal `scix-dsh-plugin`),
`locale/*.json`, `docs/`, `icon.svg`, root `README.md`. The manifest already
exports/`files`-lists them.

## Tool parameters (stable; Agent.md §4)

- `search`: `query` (string, required), `year_min`/`year_max` (integer), `arxiv_class` (string), `limit` (integer)
- `get_paper`: `bibcode` (string, required)
- `read_paper`: `bibcode` (string, required), `section` (string)
- `citation_traverse`: `bibcode` (required), `direction` (required: `backward`|`forward`), `mode` (`graph`|`chain`)
- `forward_citations`: `bibcode` (required)
- `find_gaps`: `working_set_id` (string, required)
- `export_citation`: `bibcodes` (array of string, required), `format` (required: `bibtex`|`aastex`|`ris`)
- `manage_library`: `action` (string, required), `library_id` (string), `bibcodes` (array of string)

Enum-like values are hand-checked in `execute` and rejected with `ToolArgsError`
(exported by `@deepseek-ai/dsh-tools`); the DSL has no enum node (brief §4.3).

## Test convention

- Unit tests run with **`node --test`** using only `node:test` + `node:assert`
  (system node ≥ 22 is fine). **No external test dependencies.**
- Files live under **`test/core/`** and **`test/tools/`**, named `*.test.js`.
- **Mock fetch**: never hit the real ADS API in tests; stub `globalThis.fetch`
  (or inject a fetch seam into the queue helper) and assert queue/backoff/quota
  behavior, verbatim identifiers, explicit `body_available`, deterministic exports.
- `src/contracts/**` and pure helpers (queue math, citation mapping) must stay
  dependency-free so plain node can import them:
  `node -e "import('./src/contracts/index.js').then(m => console.log(Object.keys(m)))"`.
- Modules importing `@deepseek-ai/*` (`src/core/errors.js`, `src/tools/*`,
  `src/index.js`) only load inside the DSH runtime (or via the brief §1
  Electron-as-Node route with installation-anchored resolution). Keep testable
  logic in dependency-free helpers; do not add dsh imports to contracts.
- Syntax gate for every JS file: `node --check <file>`.

## Verified installed facts used here (read-only, 2026-11-25)

- `defineTool` / `ToolArgsError`: exported by `@deepseek-ai/dsh-tools` (src/schema.ts).
- Object output schemas REQUIRE `additionalProperties: boolean` (ObjectValueSchemaSpec).
- `HarnessError`: owned by `@deepseek-ai/dsh-error` (re-exported by dsh-llm),
  `constructor(message, code, options?)`; only subclasses keep name/code on tool results.
- Installed versions: dsh-tools / dsh-credentials / dsh-error `0.2.2-rc.5`,
  cordis `~4.1.0`, schemastery `~3.19.0` → peer pins in package.json.