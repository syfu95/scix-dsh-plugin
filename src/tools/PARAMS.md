# SciX tools — final parameter & output reference (task-3, tools agent)

Authoritative for README/QA sync. Matches `src/tools/*.js` exactly (verified by
`test/tools/*.test.js` and `test/tools/real-runtime-check.mjs` against installed
dsh-tools 0.2.2-rc.5). Enum-like values are hand-checked in `execute` and
rejected with `ToolArgsError` (code `INVALID_ARGS`) per the team contract.
All bibcodes/DOIs/arXiv ids/library ids in results are VERBATIM API values.
`body_available` on metadata-only results is a signal-based estimate
(esources/property/fulltext_mtime + arXiv route); only `read_paper` confirms.
No PDF bytes or PDF links anywhere. Errors propagate as `ScixError`
(TOKEN_MISSING / RATE_LIMITED / QUOTA_EXCEEDED / API_ERROR / ABORTED).

## search
| param | type | req | default / constraints |
|---|---|---|---|
| query | string | yes | non-empty; natural language passes through to Solr |
| year_min | integer | no | inclusive; must be ≤ year_max |
| year_max | integer | no | inclusive |
| arxiv_class | string | no | e.g. `astro-ph.EP` → `fq=arxiv_class:"…"` |
| doctype | string | no | enum (22): abstract, article, book, bookreview, catalog, circular, editorial, eprint, erratum, inbook, inproceedings, mastersthesis, misc, newsletter, obituary, phdthesis, pressrelease, proceedings, proposal, software, talk, techreport |
| first_author | string | no | e.g. `Smith, J` |
| uat | string | no | UAT term label or numeric id → `fq=uat:"…"` / `uat:N` |
| limit | integer | no | default 10, range 1..100 |

Output object: `papers[]` (bibcode, title, author[], year, citation_count,
doctype, abstract ≤500 chars + `abstract_truncated`, `body_available`,
`arxiv_id`, `rrf_score`, `lexical_rank`, `similar_rank`), `total_count`,
`returned_count`, `truncated`, `ranking:'rrf-fusion'`, `ranking_k:60`,
`ranking_note` (lexical + similar() text-similarity, NOT vector semantics),
`fusion:'dual-path'|'lexical-only'`, `similar_seed_bibcode:string|null` (top
lexical hit seeds `similar(bibcode:"…")`), `fusion_note?`, `working_set_id`,
`added_to_working_set`, `body_available_note`. Hits auto-add to the session
working set (sessionKey = `exec.agent.id`, fallback `plugin-instance`).

## get_paper
| param | type | req |
|---|---|---|
| bibcode | string | yes |

Output object: full metadata (title, first_author, author[], year, pubdate,
pub, volume, page[], issue, abstract, citation_count, read_count, doi[],
identifier[], eid, alternate_bibcode[], keyword[], keyword_norm[], uat[],
aff[], doctype, arxiv_class[], property[], esources[], fulltext_mtime),
`arxiv_id:string|null` + `arxiv_id_source` (identifier|eid|bibcode),
`body_available`, `body_available_reason`, `body_available_note`, `field_note?`
(uat-in-fl 400 → one retry without uat), `working_set_id`.

## read_paper
| param | type | req | notes |
|---|---|---|---|
| bibcode | string | yes | |
| section | string | no | fuzzy title match (numbered ok), HTML id (S2, S2.SS1), or `abstract`; omitted = full text |

Output object: `bibcode`, `title?`, `body_available`,
`body_source:'arxiv-html'|'ar5iv'|'none'`, `arxiv_id:string|null`,
`sections:string[]` (titles), `section_index?` ([{id, level, title,
char_count}]), `section?`, `section_title?`, `text` (≤50000 chars),
`total_chars`, `truncated`, `note` (source URL + untrusted-content warning),
`working_set_id`. Route: arxiv.org/html/{id} → ar5iv fallback via
`requestExternal(accept:'text/html')`; never PDF, no disk cache. Non-arXiv or
failed fetch → `body_available:false` + ADS abstract + explicit note.

## citation_traverse
| param | type | req | default / constraints |
|---|---|---|---|
| bibcode | string | yes | |
| direction | string | yes | `backward` (references) \| `forward` (citing) |
| mode | string | no | `graph` (default) \| `chain` |

graph output: `papers[]` (+ `relation:'reference'|'citation'`), `total_count`,
`returned_count`, `truncated` (rows cap 100 vs numFound). chain output:
`nodes[]` (depth 0/1/2, relation), `edges[{citing, cited}]`, `max_depth:2`,
`expansion_note`. Chain bounds: ≤200 raw links/hop, metadata OR-batches ≤50,
hop-2 seeds = top 5 by citation_count, ≤10 requests. Both add results to the
working set; both include `working_set_id`, `added_to_working_set`,
`body_available_note`.

## forward_citations
| param | type | req |
|---|---|---|
| bibcode | string | yes |

Output object: `citations[]` (≤100, citation_count desc; each with
`intents:string[]|null` VERBATIM S2 taxonomy background/method/
result_comparison, `intent_source:'semantic-scholar'|null`,
`intent_contexts?` ≤2×500 chars + `contexts_truncated`, `is_influential?`,
doi[] verbatim), `total_count`, `returned_count`, `truncated`,
`intent_coverage{returned, matched, with_intents}`, `s2_paper_key:string|null`
(DOI preferred, else ARXIV), `note` (honest taxonomy + degradation),
`working_set_id`, `added_to_working_set`, `body_available_note`. S2 429/error/
no-match → `intents:null` + DEGRADED note; never fabricated labels.

## find_gaps
| param | type | req |
|---|---|---|
| working_set_id | string | yes (opaque; `ws-default` = session default) |

Output object: `method:'client-side-heuristic'`, `set_size`,
`analyzed_members` (≤10, `members_truncated?`), `candidates[]` (bibcode,
link_count, linked_by[], as_reference_of_count, as_citation_of_count, title?,
year?, citation_count?), `temporal_gaps[]` ({year_min, year_max,
neighbor_count, evidence[]}), `topic_gaps[]` ({term, source:'uat'|'keyword',
neighbor_count, evidence[]}), `author_gaps[]`, `stats`, `note` (heuristic, NOT
PageRank/private corpus). Unknown id → ScixError API_ERROR (actionable).
Excluded bibcodes filtered everywhere. Does not mutate the working set.

## export_citation
| param | type | req | constraints |
|---|---|---|---|
| bibcodes | string[] | yes | 1..2000 verbatim tokens; exact duplicates removed, order kept |
| format | string | yes | `bibtex` \| `aastex` \| `ris` |

Output root: **string** — the API `{export}` text VERBATIM (POST
`export/{format}` `{bibcode:[…]}`, no sort → server default date+bibcode
order). Zero client-side field invention; render passes text through.

## manage_library
| param | type | req | notes |
|---|---|---|---|
| action | string | yes | `list` \| `create` \| `get` \| `update` \| `delete` \| `add_documents` \| `remove_documents` |
| library_id | string | for get/update/delete/add/remove | `[A-Za-z0-9_-]{1,64}` verbatim |
| bibcodes | string[] | for add/remove; optional create seed | 1..2000 |
| name | string | for create; optional update | non-empty |
| description | string | no | create/update |
| public | boolean | no | create default false; update |

Output object: `action` + per-action fields — list: `count`, `libraries[]`;
create: `library_id?`, `library` (root-or-metadata quirk handled); get:
`library`, `documents[]`; update: `updated`; delete: `deleted:true`;
add/remove: `number_added?`/`number_removed?`, `invalid_bibcodes[]` (verbatim,
always present). Paths: delete/update/add/remove on `biblib/documents/{id}`;
list/create on `biblib/libraries`; get on `biblib/libraries/{id}`.
