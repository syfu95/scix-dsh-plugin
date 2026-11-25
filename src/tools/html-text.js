/**
 * Dependency-free HTML → text extraction for LaTeXML renderings
 * (native arXiv HTML and ar5iv). NO cheerio / no dependencies: a small
 * tolerant tokenizer + tree builder, then structural extraction over the
 * LaTeXML class vocabulary (api-brief §5, scix-arxiv-mcp pattern):
 *
 *   ltx_title_document, ltx_abstract,
 *   ltx_section / ltx_subsection / ltx_subsubsection / ltx_appendix /
 *   ltx_bibliography / ltx_acknowledgements,
 *   ltx_title_section (etc.), ltx_para / ltx_p / ltx_caption,
 *   math → TeX via the MathML `alttext` attribute.
 *
 * A parent section's text EXCLUDES nested subsections (each is its own
 * section entry, in document order). Text is untrusted external content.
 * @module tools/html-text
 */

/** Bound parser input (chars) to keep extraction CPU bounded. */
export const MAX_HTML_CHARS = 5_000_000

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])
const SKIP_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template'])
const CLOSES_OPEN_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
])
const SECTION_CLASSES = new Map([
  ['ltx_section', 1],
  ['ltx_subsection', 2],
  ['ltx_subsubsection', 3],
  ['ltx_appendix', 1],
  ['ltx_bibliography', 1],
  ['ltx_acknowledgements', 1],
])
const TITLE_CLASSES = new Set([
  'ltx_title_section', 'ltx_title_subsection', 'ltx_title_subsubsection',
  'ltx_title_appendix', 'ltx_title_bibliography', 'ltx_title_acknowledgements',
])

/**
 * Decode the HTML entities LaTeXML output actually uses.
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code) } catch { return whole }
      }
      return whole
    }
    switch (body) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return '\u00a0'
      case 'ndash': return '\u2013'
      case 'mdash': return '\u2014'
      case 'hellip': return '\u2026'
      default: return whole
    }
  })
}

/**
 * @typedef {Object} HtmlElement
 * @property {'element'} type
 * @property {string} tag Lower-case tag name.
 * @property {Record<string, string>} attrs
 * @property {HtmlNode[]} children
 * @typedef {{ type: 'text', text: string }} HtmlText
 * @typedef {HtmlElement|HtmlText} HtmlNode
 */

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/**
 * Tolerant HTML parser: comments/doctype skipped, void + self-closing tags,
 * implicit <p>/<li> closes, mismatched end tags pop to the nearest match.
 * script/style content is dropped entirely.
 * @param {string} html
 * @returns {HtmlElement} Synthetic root element.
 */
export function parseHtml(html) {
  /** @type {HtmlElement} */
  const root = { type: 'element', tag: '#root', attrs: {}, children: [] }
  /** @type {HtmlElement[]} */
  const stack = [root]
  const top = () => stack[stack.length - 1]
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      pushText(html.slice(i))
      break
    }
    if (lt > i) pushText(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt)
      i = end === -1 ? n : end + 1
      continue
    }
    const gt = findTagEnd(html, lt)
    if (gt === -1) {
      pushText(html.slice(lt))
      break
    }
    const raw = html.slice(lt + 1, gt)
    i = gt + 1
    if (raw[0] === '/') {
      const name = raw.slice(1).trim().toLowerCase()
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === name) {
          stack.length = s
          break
        }
      }
      continue
    }
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9:-]*)/.exec(raw)
    if (!nameMatch) continue
    const tag = nameMatch[1].toLowerCase()
    const selfClosing = raw.endsWith('/')
    /** @type {Record<string, string>} */
    const attrs = {}
    ATTR_RE.lastIndex = 0
    const attrSource = raw.slice(nameMatch[0].length).replace(/\/$/, '')
    let m
    while ((m = ATTR_RE.exec(attrSource)) !== null) {
      const key = m[1].toLowerCase()
      if (key === '/' || key === '') continue
      const value = m[2] ?? m[3] ?? m[4] ?? ''
      if (!(key in attrs)) attrs[key] = decodeEntities(value)
    }
    if (CLOSES_OPEN_P.has(tag) && top().tag === 'p') stack.pop()
    if (tag === 'li' && top().tag === 'li') stack.pop()
    /** @type {HtmlElement} */
    const el = { type: 'element', tag, attrs, children: [] }
    top().children.push(el)
    if (VOID_TAGS.has(tag) || selfClosing) continue
    if (SKIP_CONTENT_TAGS.has(tag)) {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
      const rest = html.slice(i)
      const closeMatch = closeRe.exec(rest)
      i = closeMatch ? i + closeMatch.index + closeMatch[0].length : n
      continue
    }
    stack.push(el)
  }
  return root

  /** @param {string} text */
  function pushText(text) {
    if (text.length === 0) return
    const decoded = decodeEntities(text)
    if (decoded.length > 0) top().children.push({ type: 'text', text: decoded })
  }
}

/** Find the '>' ending a tag, respecting quoted attribute values. */
function findTagEnd(html, start) {
  let quote = ''
  for (let j = start + 1; j < html.length; j++) {
    const c = html[j]
    if (quote) {
      if (c === quote) quote = ''
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return j
    }
  }
  return -1
}

/** @param {HtmlNode} node @param {string} cls */
export function hasClass(node, cls) {
  if (node.type !== 'element') return false
  const classes = (node.attrs.class ?? '').split(/\s+/)
  return classes.includes(cls)
}

/** @param {HtmlNode} node */
function isSectionElement(node) {
  if (node.type !== 'element') return false
  const classes = (node.attrs.class ?? '').split(/\s+/)
  return classes.some((c) => SECTION_CLASSES.has(c))
}

/** @param {HtmlNode} node */
function sectionLevel(node) {
  const classes = (node.attrs.class ?? '').split(/\s+/)
  for (const c of classes) {
    const level = SECTION_CLASSES.get(c)
    if (level !== undefined) return level
  }
  return 1
}

/**
 * Depth-first walk. `visit` may return false to skip the node's children.
 * @param {HtmlNode} node
 * @param {(node: HtmlNode) => boolean|void} visit
 */
function walk(node, visit) {
  if (visit(node) === false) return
  if (node.type === 'element') {
    for (const child of node.children) walk(child, visit)
  }
}

/**
 * Inline text of a subtree: math → `$alttext$`, script/style/annotations
 * skipped, whitespace collapsed.
 * @param {HtmlNode} node
 * @returns {string}
 */
export function inlineText(node) {
  /** @type {string[]} */
  const parts = []
  walk(node, (current) => {
    if (current.type === 'text') {
      parts.push(current.text)
      return false
    }
    const tag = current.tag
    if (SKIP_CONTENT_TAGS.has(tag) || tag === 'annotation' || tag === 'annotation-xml') return false
    if (tag === 'math') {
      const alt = current.attrs.alttext
      if (alt) parts.push(`$${alt}$`)
      return false
    }
    if (tag === 'br') parts.push(' ')
    return true
  })
  return parts.join('').replace(/\s+/g, ' ').trim()
}

/**
 * Block-level text chunks of a section-like element: ltx_p / p paragraphs,
 * ltx_caption, run-in ltx_title_paragraph, bibliography items. Nested
 * section subtrees and the element's own ltx_title_* heading are excluded.
 * @param {HtmlElement} el
 * @returns {string[]}
 */
function blockChunks(el) {
  /** @type {string[]} */
  const chunks = []
  const isBib = hasClass(el, 'ltx_bibliography')
  walk(el, (current) => {
    if (current === el) return true
    if (current.type === 'text') return false
    if (isSectionElement(current)) return false
    const classes = (current.attrs.class ?? '').split(/\s+/)
    if (classes.some((c) => TITLE_CLASSES.has(c))) return false
    if (hasClass(current, 'ltx_bibitem') && isBib) {
      const text = inlineText(current)
      if (text) chunks.push(text)
      return false
    }
    if (hasClass(current, 'ltx_p') || current.tag === 'p' || hasClass(current, 'ltx_caption')
      || hasClass(current, 'ltx_title_paragraph')) {
      const text = inlineText(current)
      if (text) chunks.push(text)
      return false
    }
    return true
  })
  return chunks
}

/**
 * First element in document order matching a predicate (scoped: does not
 * descend into nested section elements when `stopAtSections`).
 * @param {HtmlNode} root
 * @param {(node: HtmlNode) => boolean} pred
 * @param {boolean} [stopAtSections=false]
 * @returns {HtmlElement|null}
 */
function findFirst(root, pred, stopAtSections = false) {
  /** @type {HtmlElement|null} */
  let found = null
  walk(root, (node) => {
    if (found) return false
    if (node !== root && stopAtSections && isSectionElement(node)) return false
    if (node.type === 'element' && pred(node)) {
      found = node
      return false
    }
    return true
  })
  return found
}

/**
 * @typedef {Object} ExtractedSection
 * @property {string|null} id HTML id attribute verbatim (S1, S2.SS1, …).
 * @property {number} level 1 = section/appendix, 2 = subsection, 3 = subsubsection.
 * @property {string} title Section heading text verbatim (may be numbered).
 * @property {string} text Paragraph text; nested subsections excluded.
 * @property {number} char_count text.length.
 */

/**
 * Extract structure + text from a LaTeXML HTML rendering.
 * @param {string} html
 * @returns {{ title: string, abstract: string, sections: ExtractedSection[], full_text: string }}
 *   full_text = document title + abstract + every section (heading + own
 *   text) in document order; nested subsections appear exactly once.
 */
export function extractPaper(html) {
  const root = parseHtml(html.slice(0, MAX_HTML_CHARS))
  const body = findFirst(root, (node) => node.tag === 'body') ?? root

  const titleEl = findFirst(body, (node) => hasClass(node, 'ltx_title_document'))
  const title = titleEl ? inlineText(titleEl) : ''

  const abstractEl = findFirst(body, (node) => hasClass(node, 'ltx_abstract'))
  let abstract = ''
  if (abstractEl) {
    const chunks = blockChunks(abstractEl)
    abstract = chunks.length > 0 ? chunks.join('\n\n') : inlineText(abstractEl)
  }

  /** @type {ExtractedSection[]} */
  const sections = []
  walk(body, (node) => {
    if (node.type !== 'element' || !isSectionElement(node)) return true
    const heading = findFirst(node, (child) => {
      const classes = (child.attrs.class ?? '').split(/\s+/)
      return classes.some((c) => TITLE_CLASSES.has(c))
    }, true)
    const text = blockChunks(node).join('\n\n')
    sections.push({
      id: node.attrs.id ?? null,
      level: sectionLevel(node),
      title: heading ? inlineText(heading) : '(untitled section)',
      text,
      char_count: text.length,
    })
    return true
  })

  if (sections.length === 0) {
    // Fallback: no ltx_section structure — one pseudo-section from all
    // paragraphs outside the abstract (still real rendered text).
    /** @type {string[]} */
    const chunks = []
    walk(body, (node) => {
      if (node.type !== 'element') return false
      if (hasClass(node, 'ltx_abstract') || hasClass(node, 'ltx_bibliography')) return false
      if (hasClass(node, 'ltx_p') || node.tag === 'p') {
        const text = inlineText(node)
        if (text) chunks.push(text)
        return false
      }
      return true
    })
    const text = chunks.join('\n\n')
    if (text.length > 0) {
      sections.push({ id: 'body', level: 1, title: 'Body', text, char_count: text.length })
    }
  }

  const fullParts = []
  if (title) fullParts.push(title)
  if (abstract) fullParts.push(`Abstract\n${abstract}`)
  for (const section of sections) {
    fullParts.push(section.title ? `${section.title}\n${section.text}` : section.text)
  }
  return { title, abstract, sections, full_text: fullParts.join('\n\n') }
}

/**
 * Normalize a heading for fuzzy matching: lowercase, collapse whitespace,
 * strip leading section numbering ("2.1 ", "3) ", "IV. ").
 * @param {string} value
 * @returns {string}
 */
export function normalizeHeading(value) {
  return value
    .toLowerCase()
    .replace(/^\s*(?:\d+(?:\.\d+)*[.)]?|[ivxlcdm]+[.)])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fuzzy section selection (case-insensitive; numbered titles ok).
 * Tiers: exact normalized title / exact id → title starts with query →
 * title contains query. First match in document order wins within a tier.
 * @param {ExtractedSection[]} sections
 * @param {string} query
 * @returns {ExtractedSection|null}
 */
export function selectSection(sections, query) {
  const q = normalizeHeading(query)
  if (q.length === 0) return null
  const norm = sections.map((s) => normalizeHeading(s.title))
  for (let i = 0; i < sections.length; i++) {
    if (norm[i] === q || (sections[i].id ?? '').toLowerCase() === q) return sections[i]
  }
  for (let i = 0; i < sections.length; i++) {
    if (norm[i].startsWith(q)) return sections[i]
  }
  for (let i = 0; i < sections.length; i++) {
    if (norm[i].includes(q)) return sections[i]
  }
  return null
}
