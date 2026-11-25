/**
 * Integration parity gate (QA, task-6): the Client half's comment claims the
 * UI_STRINGS literal is kept identical to the "ui" sections of locale/zh.json
 * and locale/en.json, but no persistent gate existed. This test is that gate.
 * It also checks manifest ↔ disk parity: exports/files targets, the bundle
 * patch row, and locale meta.detail documents + their referenced images.
 * Plain node:test + node:assert; no dsh imports (contracts stay dependency-free).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PACKAGE_NAME, ROW_ID } from '../../src/contracts/ui.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const exists = (rel) => fs.existsSync(path.join(ROOT, rel))

test('client UI_STRINGS literal is byte-identical to locale/zh.json and locale/en.json "ui" sections', () => {
  const source = read('client/index.js')
  const match = source.match(/const UI_STRINGS = (\{[\s\S]*?\n    \});/)
  assert.ok(match, 'UI_STRINGS literal not found in client/index.js')
  // The literal is documented as valid JSON (quoted keys + string values only).
  const ui = JSON.parse(match[1])
  for (const lang of ['zh', 'en']) {
    const locale = JSON.parse(read(`locale/${lang}.json`))
    assert.deepEqual(ui[lang], locale.ui, `client UI_STRINGS.${lang} drifted from locale/${lang}.json "ui"`)
  }
})

test('package.json exports/files targets exist on disk (linked bundle: files does not filter)', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, PACKAGE_NAME)
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './client/index.js')
  for (const target of Object.values(pkg.exports)) {
    if (target.includes('*')) continue // pattern export checked via concrete files below
    assert.ok(exists(target.replace(/^\.\//, '')), `exports target missing: ${target}`)
  }
  for (const entry of pkg.files) {
    if (entry === 'locale/*.json') {
      assert.ok(exists('locale/zh.json') && exists('locale/en.json'), 'locale files missing')
      continue
    }
    assert.ok(exists(entry), `files entry missing: ${entry}`)
  }
  assert.ok(exists(pkg.dsh.bundle.patch.replace(/^\.\//, '')), 'bundle patch file missing')
})

test('cordis.patch.yml inserts exactly the contract row id/name', () => {
  const patch = read('cordis.patch.yml')
  assert.ok(patch.includes(`- id: ${ROW_ID}`), `patch row id must be ${ROW_ID}`)
  assert.ok(patch.includes(`name: ${PACKAGE_NAME}`), `patch row name must be ${PACKAGE_NAME}`)
})

test('locale meta.detail documents exist and reference an existing image', () => {
  for (const lang of ['zh', 'en']) {
    const meta = JSON.parse(read(`locale/${lang}.json`)).meta
    assert.ok(typeof meta.title === 'string' && meta.title.length > 0)
    assert.ok(typeof meta.description === 'string' && meta.description.length > 0)
    assert.ok(exists(meta.detail), `locale/${lang}.json meta.detail missing on disk: ${meta.detail}`)
    const doc = read(meta.detail)
    const images = [...doc.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1])
    assert.ok(images.length >= 1, `${meta.detail} must reference its feature image`)
    for (const image of images) {
      const rel = path.join(path.dirname(meta.detail), image)
      assert.ok(exists(rel), `${meta.detail} references missing image: ${image}`)
    }
  }
})
