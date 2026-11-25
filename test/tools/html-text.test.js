/**
 * Dependency-free LaTeXML extraction: native arXiv HTML + ar5iv fixtures,
 * nested-section exclusion, math alttext, entities, fuzzy section selection.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractPaper, selectSection, normalizeHeading, decodeEntities, parseHtml, inlineText } from '../../src/tools/html-text.js'
import { htmlNativeArxiv, htmlAr5iv } from './fixtures.js'

test('native arXiv HTML: document title, abstract, section structure', () => {
  const paper = extractPaper(htmlNativeArxiv)
  assert.equal(paper.title, 'A Study of Exoplanet Atmospheres')
  assert.equal(paper.abstract, 'We study atmospheres & clouds.')
  assert.deepEqual(paper.sections.map((s) => s.id), ['S1', 'S1.SS1', 'S2', 'S3', 'bib'])
  assert.deepEqual(paper.sections.map((s) => s.title), ['1 Introduction', '1.1 Background', '2 Methods', '3 Results', 'References'])
  assert.deepEqual(paper.sections.map((s) => s.level), [1, 2, 1, 1, 1])
})

test('parent section text excludes nested subsections; full_text covers each once', () => {
  const paper = extractPaper(htmlNativeArxiv)
  const s1 = paper.sections.find((s) => s.id === 'S1')
  assert.ok(s1.text.includes('Intro text with citation [1].'))
  assert.ok(!s1.text.includes('Background paragraph.'))
  const s1ss1 = paper.sections.find((s) => s.id === 'S1.SS1')
  assert.equal(s1ss1.text, 'Background paragraph.')
  assert.equal(paper.full_text.split('Background paragraph.').length - 1, 1)
  assert.equal(paper.full_text.split('Results paragraph one.').length - 1, 1)
})

test('math renders via alttext; captions included; script/style dropped', () => {
  const paper = extractPaper(htmlNativeArxiv)
  const s2 = paper.sections.find((s) => s.id === 'S2')
  assert.ok(s2.text.includes('We fit $E=mc^{2}$ to the data.'))
  assert.ok(s2.text.includes('Figure 1: pipeline.'))
  assert.ok(!paper.full_text.includes('var tracking'))
  assert.ok(!paper.full_text.includes('ltx_page_main'))
  const s3 = paper.sections.find((s) => s.id === 'S3')
  assert.equal(s3.text, 'Results paragraph one.\n\nResults paragraph two.')
  assert.equal(s3.char_count, s3.text.length)
})

test('bibliography items are extracted as section text', () => {
  const paper = extractPaper(htmlNativeArxiv)
  const bib = paper.sections.find((s) => s.id === 'bib')
  assert.ok(bib.text.includes('Smith 2020, ApJ, 1'))
})

test('ar5iv shape: div-based numbered sections + appendix, entity decoding', () => {
  const paper = extractPaper(htmlAr5iv)
  assert.equal(paper.title, 'An Older Preprint')
  assert.deepEqual(paper.sections.map((s) => s.title),
    ['1. Introduction', '2. Methods', '2.1. Fitting Procedure', '3. Results and Discussion', 'Appendix A. Derivations'])
  const intro = paper.sections[0]
  assert.ok(intro.text.includes('Ar5iv intro paragraph \u2013 with entity.'))
  const methods = paper.sections.find((s) => s.id === 'S2')
  assert.ok(methods.text.includes('Ar5iv methods paragraph.'))
  assert.ok(!methods.text.includes('Ar5iv fitting details.'))
  assert.ok(paper.full_text.includes('Appendix derivation text.'))
  assert.ok(!paper.full_text.includes('margin: 0'))
})

test('fuzzy section selection: case-insensitive, numbered titles, ids, tiers', () => {
  const native = extractPaper(htmlNativeArxiv).sections
  assert.equal(selectSection(native, 'methods').id, 'S2')
  assert.equal(selectSection(native, 'METHODS').id, 'S2')
  assert.equal(selectSection(native, '2 Methods').id, 'S2')
  assert.equal(selectSection(native, 'results').id, 'S3')
  assert.equal(selectSection(native, 'S1.SS1').id, 'S1.SS1')
  assert.equal(selectSection(native, 'background').id, 'S1.SS1')
  assert.equal(selectSection(native, 'nonexistent section'), null)
  const ar5iv = extractPaper(htmlAr5iv).sections
  assert.equal(selectSection(ar5iv, '2.1 fitting procedure').id, 'S2.SS1')
  assert.equal(selectSection(ar5iv, 'fitting').id, 'S2.SS1')
  assert.equal(selectSection(ar5iv, 'discussion').id, 'S3')
  assert.equal(selectSection(ar5iv, 'derivations').id, 'A1')
})

test('normalizeHeading strips numbering styles', () => {
  assert.equal(normalizeHeading('2.1 Methods'), 'methods')
  assert.equal(normalizeHeading('3) Results'), 'results')
  assert.equal(normalizeHeading('IV. Discussion'), 'discussion')
  assert.equal(normalizeHeading('  Methods  '), 'methods')
})

test('fallback: HTML without ltx_section structure yields one Body section', () => {
  const paper = extractPaper('<html><body><p>One &amp; only.</p><p>Two.</p></body></html>')
  assert.equal(paper.sections.length, 1)
  assert.equal(paper.sections[0].title, 'Body')
  assert.equal(paper.sections[0].text, 'One & only.\n\nTwo.')
})

test('empty HTML yields no sections and empty full_text (read_paper degrades)', () => {
  const paper = extractPaper('<html><body></body></html>')
  assert.deepEqual(paper.sections, [])
  assert.equal(paper.full_text, '')
})

test('tokenizer tolerates mismatched tags, void elements, comments, quotes in attrs', () => {
  const root = parseHtml('<div><p>a<br>b</div><!-- <p>hidden</p> --><img src="x.png"><p title="a>b">c</p>')
  const texts = []
  const walk = (node) => {
    if (node.type === 'text') texts.push(node.text)
    else node.children.forEach(walk)
  }
  walk(root)
  assert.ok(texts.join('').includes('ab'))
  assert.ok(texts.join('').includes('c'))
  assert.ok(!texts.join('').includes('hidden'))
})

test('decodeEntities handles named + numeric references', () => {
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;&nbsp;&#65;&#x42;'), '&<>"\'\u00a0AB')
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;')
})

test('inlineText skips annotation subtrees and collapses whitespace', () => {
  const root = parseHtml('<p> a <math alttext="x^2"><annotation>x^2</annotation></math>  b </p>')
  const p = root.children[0]
  assert.equal(inlineText(p), 'a $x^2$ b')
})
