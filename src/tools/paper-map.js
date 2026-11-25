/**
 * ADS document → tool-result mapping. Dependency-free (plain node).
 *
 * Rules (contracts/tools.js):
 * - Identifiers (bibcode, doi, identifier, eid, arxiv_id) are copied VERBATIM
 *   from the API doc. The only derived value is the arXiv id used for the
 *   HTML text route, resolved with identifier/eid PREFERRED over bibcode
 *   parsing (design decision B); the derivation is deterministic and the
 *   source field is documented per paper.
 * - body_available on metadata-only results is a SIGNAL-BASED ESTIMATE
 *   (api-brief §5/§9: esources/property/fulltext_mtime + arXiv-route
 *   availability). Only read_paper's live fetch confirms retrievability;
 *   every estimate carries that caveat in its note.
 * - ADS `title` is an array; we surface its first element verbatim.
 * - ADS `year` is a string; PaperRef.year is a number (type coercion only).
 * @module tools/paper-map
 */

/** fl for search / list results (bounded but body-signal complete). */
export const SEARCH_FL =
  'bibcode,title,author,year,citation_count,abstract,identifier,eid,esources,property,doctype'
/** Broad fl for get_paper (lead spec; api-brief §2 get_paper row). */
export const GET_PAPER_FL =
  'bibcode,title,first_author,author,year,pubdate,abstract,citation_count,read_count,' +
  'doi,pub,volume,page,issue,keyword,keyword_norm,aff,identifier,eid,esources,property,' +
  'doctype,arxiv_class,uat,fulltext_mtime,alternate_bibcode'
/** fl for citation_traverse / forward_citations list results. */
export const TRAVERSE_FL =
  'bibcode,title,author,year,citation_count,identifier,eid,esources,property,doctype'
/** forward_citations additionally needs DOI for Semantic Scholar matching. */
export const FORWARD_FL = `${TRAVERSE_FL},doi`
/** Raw second-order link lists (api-brief §2: reference/citation are retrievable). */
export const LINKS_FL = 'bibcode,reference,citation'
/** find_gaps member fetch: metadata + raw link lists in one batched query. */
export const GAP_MEMBER_FL =
  'bibcode,title,author,first_author,year,citation_count,keyword,keyword_norm,uat,reference,citation'
/** find_gaps neighbor metadata fetch. */
export const GAP_NEIGHBOR_FL =
  'bibcode,title,author,first_author,year,citation_count,keyword,uat,doctype'

/** Shared caveat for every signal-based body_available estimate. */
export const BODY_ESTIMATE_NOTE =
  'body_available is estimated from ADS metadata signals (arXiv id + esources/property/fulltext_mtime); ' +
  'only read_paper confirms actual text retrieval. Non-arXiv papers have no text route: ADS body text is ' +
  'searchable but not retrievable, and publisher pages are never scraped. No PDF route is ever used.'

const ARXIV_NEW = /^\d{4}\.\d{4,5}(?:v\d+)?$/
const ARXIV_OLD = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/i

/** @param {unknown} value @returns {string[]} */
function stringArray(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []
}

/** @param {unknown} value @returns {Set<string>} upper-cased token set */
function upperSet(value) {
  return new Set(stringArray(value).map((v) => v.toUpperCase()))
}

/**
 * First title element, verbatim (ADS titles are arrays).
 * @param {Record<string, unknown>} doc
 * @returns {string|undefined}
 */
export function firstTitle(doc) {
  const t = doc.title
  if (Array.isArray(t)) return typeof t[0] === 'string' ? t[0] : undefined
  return typeof t === 'string' ? t : undefined
}

/**
 * Publication year as a number when the API value parses; else undefined.
 * @param {Record<string, unknown>} doc
 * @returns {number|undefined}
 */
export function toYear(doc) {
  const y = Number(doc.year)
  return Number.isFinite(y) && doc.year !== undefined && doc.year !== null && `${doc.year}`.trim() !== ''
    ? y
    : undefined
}

/**
 * Resolve the arXiv id for the HTML text route. Preference order (decision B):
 * 1. `identifier` entries (`arXiv:…` prefixed or bare id forms),
 * 2. `eid` (often `arXiv:…` for eprints),
 * 3. documented bibcode parsing fallback (new-style `YYYYarXiv<9 chars>A`,
 *    old-style `YYYY<archive>..<4 digits>A`).
 * The returned id keeps any `vN` version suffix verbatim; only the `arXiv:`
 * prefix is stripped (it is a scheme label, not part of the id).
 * @param {Record<string, unknown>} doc
 * @returns {{ arxiv_id: string, source: 'identifier'|'eid'|'bibcode' }|null}
 */
export function resolveArxivId(doc) {
  for (const raw of stringArray(doc.identifier)) {
    const prefixed = /^arxiv:\s*(.+)$/i.exec(raw)
    const cand = (prefixed ? prefixed[1] : raw).trim()
    if (ARXIV_NEW.test(cand) || ARXIV_OLD.test(cand)) {
      return { arxiv_id: cand, source: 'identifier' }
    }
  }
  if (typeof doc.eid === 'string') {
    const cand = doc.eid.replace(/^arxiv:\s*/i, '').trim()
    if (ARXIV_NEW.test(cand) || ARXIV_OLD.test(cand)) {
      return { arxiv_id: cand, source: 'eid' }
    }
  }
  const bibcode = typeof doc.bibcode === 'string' ? doc.bibcode : ''
  if (bibcode.length === 19) {
    // New-style: 2021arXiv210301234X (dotless) or 2021arXiv2103.0123X (dotted).
    const newStyle = /^\d{4}arXiv(.{9})[A-Za-z]$/.exec(bibcode)
    if (newStyle) {
      const stem = newStyle[1]
      const cand = /^\d{9}$/.test(stem) ? `${stem.slice(0, 4)}.${stem.slice(4)}` : stem
      if (ARXIV_NEW.test(cand)) return { arxiv_id: cand, source: 'bibcode' }
    }
    // Old-style: 2001astro.ph..1001S → astro-ph/0101001. The 4-digit tail is
    // MMNNN with leading zeros dropped; the year supplies YY.
    const oldStyle = /^(\d{4})([A-Za-z][A-Za-z.-]*?)\.\.(\d{4})[A-Za-z]$/.exec(bibcode)
    if (oldStyle) {
      const archive = oldStyle[2].replace(/\.+$/, '').replace(/\./g, '-')
      const cand = `${archive}/${oldStyle[1].slice(2)}${oldStyle[3].padStart(5, '0')}`
      if (ARXIV_OLD.test(cand)) return { arxiv_id: cand, source: 'bibcode' }
    }
  }
  return null
}

/**
 * Signal-based body availability estimate (api-brief §5/§9). True only when
 * an arXiv id exists AND at least one fulltext signal supports the HTML/ar5iv
 * text route. read_paper remains the only confirmation.
 * @param {Record<string, unknown>} doc
 * @returns {{ available: boolean, arxiv_id: string|null, arxiv_id_source: string|null, reason: string }}
 */
export function detectBodyAvailability(doc) {
  const resolved = resolveArxivId(doc)
  if (!resolved) {
    return {
      available: false,
      arxiv_id: null,
      arxiv_id_source: null,
      reason: 'no arXiv identifier in ADS metadata; no text route (ADS body is not retrievable)',
    }
  }
  const es = upperSet(doc.esources)
  const prop = upperSet(doc.property)
  const eprintHtml = es.has('EPRINT_HTML')
  const anyEprint = eprintHtml || es.has('EPRINT_PDF') || prop.has('EPRINT')
  const ingested = typeof doc.fulltext_mtime === 'string' && doc.fulltext_mtime.length > 0
  const available = eprintHtml || anyEprint || ingested
  const reason = eprintHtml
    ? 'ADS lists EPRINT_HTML (arXiv HTML rendering)'
    : anyEprint
      ? 'arXiv eprint exists; ar5iv may render text even without native HTML'
      : ingested
        ? 'ADS ingested fulltext (fulltext_mtime set); arXiv HTML/ar5iv route plausible'
        : 'arXiv id present but no fulltext signals; HTML/ar5iv rendering may not exist'
  return { available, arxiv_id: resolved.arxiv_id, arxiv_id_source: resolved.source, reason }
}

/**
 * Minimal verbatim reference for working sets (contracts/tools.js PaperRef).
 * @param {Record<string, unknown>} doc
 * @returns {{ bibcode: string, title?: string, author?: string[], year?: number }|null}
 */
export function mapPaperRef(doc) {
  if (typeof doc.bibcode !== 'string' || doc.bibcode.length === 0) return null
  /** @type {{ bibcode: string, title?: string, author?: string[], year?: number }} */
  const ref = { bibcode: doc.bibcode }
  const title = firstTitle(doc)
  if (title !== undefined) ref.title = title
  const author = stringArray(doc.author)
  if (author.length > 0) ref.author = [...author]
  const year = toYear(doc)
  if (year !== undefined) ref.year = year
  return ref
}

/** Default abstract snippet bound for list results (explicit truncation flag). */
export const ABSTRACT_SNIPPET_CHARS = 500

/**
 * List-result paper: PaperRef + citation_count + abstract snippet +
 * signal-based body_available. All API values verbatim except the marked
 * abstract truncation and the year type coercion.
 * @param {Record<string, unknown>} doc
 * @returns {Record<string, unknown>|null}
 */
export function mapListPaper(doc) {
  const ref = mapPaperRef(doc)
  if (!ref) return null
  /** @type {Record<string, unknown>} */
  const paper = { ...ref }
  if (typeof doc.citation_count === 'number') paper.citation_count = doc.citation_count
  if (typeof doc.doctype === 'string') paper.doctype = doc.doctype
  if (typeof doc.abstract === 'string' && doc.abstract.length > 0) {
    paper.abstract = doc.abstract.slice(0, ABSTRACT_SNIPPET_CHARS)
    paper.abstract_truncated = doc.abstract.length > ABSTRACT_SNIPPET_CHARS
  }
  const body = detectBodyAvailability(doc)
  paper.body_available = body.available
  paper.arxiv_id = body.arxiv_id
  return paper
}
