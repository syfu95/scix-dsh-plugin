# scix-dsh-plugin

SciX / NASA ADS literature plugin for DeepSeek Harness (DSH): literature search, citation-network analysis, and full-text reading embedded in DSH's conversational research workflow.

[中文](README.md) | **English**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Positioning

This plugin embeds SciX / NASA ADS search, citation-network analysis, and full-text reading into DSH's conversation and research workflow, within the bounds of compliance. The plugin **does not replace the user's judgment**; it provides traceable, verifiable literature tools: identifiers such as bibcode, DOI, and arXiv id always come from raw API responses and can be checked one by one against the ADS/SciX website.

SciX and ADS use the same API (the official SciX help states "SciX uses the same API as ADS"). The plugin's default service base URL is `https://api.adsabs.harvard.edu/v1`.

## Hard Constraints

The following constraints must never be violated (see [Agent.md](Agent.md) §2):

1. **Never download, cache, or re-host PDF full-text files.** The ADS/SciX terms of service prohibit systematic article downloads. The plugin only obtains metadata and body text through the API; it never touches PDF streams, never requests PDF endpoints, and never follows PDF redirects. No tool result contains PDF bytes or PDF download links.
2. **Every user uses their own free ADS API token.** The token is entered on the plugin settings page and stored in the DSH credential store (credential reference `SCIX_API_TOKEN`). It is never hardcoded, centrally managed, or shared, and never appears in plaintext configuration, patch YAML, logs, or tool results.
3. **Respect rate limits.** The plugin enforces a local request queue: a burst cap of **15 requests/second** and a daily quota of **3000 requests** — more conservative than the official policy of 5000 requests/day for most request types. Actual limits are authoritative per endpoint via the `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset` response headers (reset at midnight UTC daily). On `429`, the plugin retries with exponential backoff (starting at 1 s, doubling per retry, exponential waits capped at 60 s; at most 5 retries = 6 sends total; a longer `Retry-After` / `X-RateLimit-Reset` instruction wins and is not bound by the 60 s cap); when the local quota is exhausted it rejects immediately with a retry time and sends nothing further. It never stress-tests the API with concurrent bursts.
4. **Citation export must be deterministic.** Author, year, DOI, bibcode, and other fields map directly from API-returned data; the export text is generated server-side by the ADS export endpoint and passed through verbatim. Model "recall" or completion is forbidden.

## Capabilities and Honest Boundaries

These are the confirmed capability boundaries (capabilities the public API does not have are stated plainly, never oversold):

1. **`search`: dual-lane fused retrieval, not vector semantic search.** The public SciX/ADS API has no vector/embedding endpoint. This plugin runs Solr lexical search plus `similar()` text similarity (MoreLikeThis-style abstract text similarity) as two lanes, fused with Reciprocal Rank Fusion (RRF, k=60). It supports natural-language queries and structured filters: year range (`year_min`/`year_max`), arXiv class (`arxiv_class`), document type (`doctype`), first author (`first_author`), and UAT (Unified Astronomy Thesaurus) concepts (`uat`, term label or numeric id) are all dedicated optional parameters; Solr field syntax is also accepted inside `query`.
2. **`read_paper`: plain text for arXiv papers only.** For papers with an arXiv identifier, the plugin fetches plain text via official arXiv HTML (`arxiv.org/html/{id}`) or ar5iv (`ar5iv.labs.arxiv.org/html/{id}`) and parses it into sections. It never touches PDFs and never writes cache files to disk. For other papers (or when no arXiv HTML rendering is available) it explicitly returns `body_available: false` with the abstract — never silently skipping or fabricating body content. Background: the public ADS API's `body` field is searchable but not retrievable, and no public fulltext endpoint exists.
3. **`forward_citations`: citing list from ADS, intent annotation best-effort.** ADS/SciX itself has no citation-intent field. Intent annotation comes from the Semantic Scholar public API — only DOI/arXiv identifiers are sent, never full text — using its real taxonomy `background` / `method` / `result_comparison`, with the data source explicitly attributed (`intent_source: "semantic-scholar"`); when no data is available, `intents: null` (S2 rate limiting/errors/no match likewise degrade to `intents: null` with an explicit degradation note — never silently). Labels such as support/extend/contrast exist in no API, and this plugin never fabricates them. Unauthenticated Semantic Scholar requests share a rate-limit pool, so intent annotation is a best-effort enrichment with limited coverage.
4. **`find_gaps`: client-side heuristic analysis.** Based on the session working set, the plugin fetches citing/referenced papers through the public API, groups and ranks them by UAT/keyword/year, and outputs heuristic gap candidates. This is not PageRank/Leiden community analysis over a private corpus (that would require a self-hosted database, which the public API does not provide).

The plugin does not bypass the ADS API to scrape publisher pages, does not generate citation entries that "look sourced" but are not API-verified, and does not send full-text content to third-party services beyond ADS/SciX and the model provider you explicitly configured (Semantic Scholar receives identifiers only).

**Session working sets**: in-memory, isolated per conversation, with the default set `ws-default`; `search` hits are added to the working set automatically, and `find_gaps` and citation analysis can be scoped to a working set. Working sets are cleared when the plugin unloads.

## Tool Overview

The names and parameter schemas of all 8 tools are a stable contract (see [src/contracts/README.md](src/contracts/README.md)); parameter naming is exact and no aliases are provided. Full parameter constraints and output fields: [src/tools/PARAMS.md](src/tools/PARAMS.md).

| Tool | Purpose | Parameters | Return highlights |
| --- | --- | --- | --- |
| `search` | Hybrid fused search | `query` (string, required); `year_min`/`year_max` (integer); `arxiv_class` (string); `doctype` (string, one of 22 ADS document types); `first_author` (string); `uat` (string, term label or numeric id); `limit` (integer, 1..100, default 10) | Paper list: bibcode, title, authors, year, citation count, abstract snippet (≤500 chars, truncation flagged); RRF fusion ranking (`ranking: "rrf-fusion"`, not vector semantics); hits enter the session working set automatically |
| `get_paper` | Full metadata for one paper | `bibcode` (string, required) | Full-field metadata, citation count, `body_available` (signal-based estimate; only `read_paper` confirms) |
| `read_paper` | Read body plain text | `bibcode` (string, required); `section` (string, optional: fuzzy section-title match, HTML id such as `S2`/`S2.SS1`, or `abstract`; omitted reads the full text) | Plain text of the requested section or the full body (arXiv HTML/ar5iv), ≤50000 chars with a `truncated` flag; when unavailable, `body_available: false` + abstract |
| `citation_traverse` | Citation-chain traversal | `bibcode` (string, required); `direction` (required: `backward`/`forward`); `mode` (`graph`/`chain`, default `graph`) | Related-paper list with relation types (`backward` = references, `forward` = citing papers); graph one-hop ≤100 rows, chain depth ≤2, truncation flagged |
| `forward_citations` | Citing papers + intent | `bibcode` (string, required) | Citing list (ADS, ≤100) + best-effort intent annotation (Semantic Scholar's real taxonomy, source attributed via `intent_source`; `intents: null` with a degradation note when no data) |
| `find_gaps` | Working-set gap analysis | `working_set_id` (string, required; `ws-default` is the session default set) | Heuristic gap candidates (`method: "client-side-heuristic"`): under-studied temporal/topic/author connection points |
| `export_citation` | Deterministic citation export | `bibcodes` (array of string, required, 1..2000, exact duplicates removed, order kept); `format` (required: `bibtex`/`aastex`/`ris`) | Bibliography text (string), verbatim output of the API export endpoint |
| `manage_library` | Personal library operations | `action` (required: `list`/`create`/`get`/`update`/`delete`/`add_documents`/`remove_documents`); `library_id` (string, required for get/update/delete/add/remove); `bibcodes` (array of string, required for add/remove, optional create seed); `name` (string, required for create); `description` (string, optional); `public` (boolean, optional, create default false) | Library operation results; add/remove return `number_added`/`number_removed` and `invalid_bibcodes` (verbatim) |

**Return conventions (every tool must honor these):**

- Identifiers such as bibcode, DOI, arXiv id, and library id are copied byte-for-byte from raw API responses — no model-side rewriting, trimming, or "recall".
- Any result describing a paper always carries an explicit boolean `body_available`; when body text is unavailable, it says so explicitly.
- No result contains PDF bytes or PDF download links.
- Omissions/truncation are marked explicitly (e.g. `truncated: true`, `total_count`).
- When no token is configured, the tool returns an actionable message (error code `TOKEN_MISSING`, pointing to the settings page and the free token page) instead of an uncaught exception.

## Installation

### Version requirements

- DSH version range: `engines.dsh: ">=0.2.0 <0.3.0"` (prereleases participate in range matching); developed and verified against DSH **0.2.2-rc.5**.
- Plugin version: 0.1.0. Installation runs the version-compatibility check before any download/link step and refuses incompatible versions outright.
- This package is not published to npm (`private: true`); install from a local directory or the Git repository.

### Option 1: DSH local install (recommended)

In a DSH session, ask the agent to call `plugin_manager` with `action: install_bundle` and `target` set to the **absolute path** of the repository root (the directory containing `package.json` and `cordis.patch.yml`):

```json
{ "action": "install_bundle", "target": "/absolute/path/to/scix-dsh-plugin", "enabled": true }
```

- A local install **links** the directory (pnpm link) into the current profile and registers it as a bundle; the change affects every session in that profile and survives restarts. `enabled: true` enables the bundle at install time.
- GUI equivalent: **Plugins → Add plugin**, paste the same absolute path.
- On Desktop profiles the application's own package manager performs the install; no system pnpm is required.
- Iterating: after editing files in place, configuration changes hot-reload via HMR; replacing the installed package as a whole requires `remove_bundle` then `install_bundle` again, plus a restart to load fresh JS modules.
- Do not hand-edit the profile's `package.json` / `cordis.patch.yml` and do not run pnpm manually in the profile directory — `install_bundle` performs those steps.
- `plugin_manager` actions require the session to hold the corresponding file-access permission (danger-full-access) or per-call approval.

### Option 2: Install from GitHub

```bash
git clone https://github.com/syfu95/scix-dsh-plugin.git
```

Then follow Option 1, using the absolute path of the cloned directory as `target` for `install_bundle`.

## Configuring the API Token

1. **Get a free token.** ADS: <https://ui.adsabs.harvard.edu/#user/settings/token>; SciX: <https://scixplorer.org/user/settings/token>. SciX and ADS use the same API; whether one token works on both hosts is subject to the plugin's verification result.
2. **Enter it on the plugin settings page.** DSH **Plugins** page → `scix-dsh-plugin` → **Configure**, paste your personal token into the token input, and click **Save**.
3. **Verify.** Click **Verify**: the plugin sends one lightweight authenticated query (`search/query?q=*:*&rows=1&fl=id`) to the configured API base and reports the outcome by HTTP status (200 = valid; 401 = invalid or missing token; 429 = rate limited). Verification never echoes the token.

**Storage and security**: the token is stored in the DSH credential store (credential reference `SCIX_API_TOKEN`), not in plaintext configuration; no read path returns the secret, and it is never written to logs or tool results. A rotated token applies to the next request without restarting the plugin. When no token is configured, tool calls return an actionable message pointing to the settings page.

**Non-secret configuration fields** (same settings page):

| Field | Default | Description |
| --- | --- | --- |
| `apiBaseUrl` | `https://api.adsabs.harvard.edu/v1` | API root URL; can be changed to `https://api.scixplorer.org/v1` (SciX host) |
| `requestTimeoutMs` | `30000` | Per-request timeout in milliseconds |

## License

[MIT](LICENSE) © 2026 syfu95
