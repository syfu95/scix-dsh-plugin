/** Client-side gap heuristics over API-derived links/facets (pure fixtures). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeGaps, countNeighborLinks, GAP_LIMITS } from '../../src/tools/gaps.js'

const member = (bibcode, year, extra = {}) => ({
  bibcode, title: [`Member ${bibcode}`], author: ['Smith, Jane'], year: `${year}`,
  uat: ['Exoplanets'], keyword: ['transits'], ...extra,
})
const neighbor = (bibcode, year, cc, extra = {}) => ({
  bibcode, title: [`External ${bibcode}`], year: `${year}`, citation_count: cc, ...extra,
})

function fixture() {
  const members = [
    member('M1', 2015, { reference: ['E1', 'E2', 'E3'], citation: ['E4', 'E5'] }),
    member('M2', 2016, { reference: ['E1', 'E2'], citation: ['E4', 'E6'] }),
    member('M3', 2017, { reference: ['E2', 'E3'], citation: ['E5', 'E6'] }),
  ]
  const neighbors = [
    neighbor('E1', 2022, 100, { uat: ['Gravitational waves'], keyword: ['LIGO'], first_author: 'Fu, Mei' }),
    neighbor('E2', 2022, 90, { uat: ['Gravitational waves'], first_author: 'Fu, Mei' }),
    neighbor('E3', 2022, 80, { keyword: ['LIGO'], first_author: 'Gao, Lin' }),
    neighbor('E4', 2023, 70, { uat: ['Gravitational waves'], first_author: 'Fu, Mei' }),
    neighbor('E5', 2023, 60, { keyword: ['LIGO'], first_author: 'Gao, Lin' }),
    neighbor('E6', 2023, 50, { uat: ['Black holes'], first_author: 'Hu, Bo' }),
  ]
  return { members, neighbors }
}

test('candidates: frequently-linked externals ranked by link count then citations, evidence verbatim', () => {
  const { members, neighbors } = fixture()
  const result = analyzeGaps({ members, neighbors })
  assert.deepEqual(result.candidates.map((c) => c.bibcode), ['E2', 'E1', 'E3', 'E4', 'E5', 'E6'])
  const e2 = result.candidates[0]
  assert.equal(e2.link_count, 3)
  assert.deepEqual(e2.linked_by, ['M1', 'M2', 'M3'])
  assert.equal(e2.as_reference_of_count, 3)
  assert.equal(e2.as_citation_of_count, 0)
  assert.equal(e2.year, 2022)
  assert.equal(e2.citation_count, 90)
  const e4 = result.candidates.find((c) => c.bibcode === 'E4')
  assert.equal(e4.as_citation_of_count, 2)
  assert.equal(e4.as_reference_of_count, 0)
  assert.equal(result.stats.external_papers_linked, 6)
})

test('excluded bibcodes are filtered from every signal', () => {
  const { members, neighbors } = fixture()
  const result = analyzeGaps({ members, neighbors, excluded: ['E6', 'E2'] })
  assert.ok(!result.candidates.some((c) => c.bibcode === 'E6' || c.bibcode === 'E2'))
  assert.ok(!result.topic_gaps.some((g) => g.term === 'Black holes'))
  assert.ok(!result.author_gaps.some((g) => g.author === 'Hu, Bo'))
  assert.equal(result.stats.external_papers_linked, 4)
  // E2/E6 excluded → each year drops to 2 neighbors (< threshold 3) → no temporal gap.
  assert.deepEqual(result.temporal_gaps, [])
})

test('temporal gaps: active neighbor years unrepresented in the set, with evidence', () => {
  const { members, neighbors } = fixture()
  const result = analyzeGaps({ members, neighbors })
  // 2022 has 3 neighbors (>= threshold 3); 2023 has 3 (E4,E5,E6) → one range.
  assert.deepEqual(result.temporal_gaps, [{
    year_min: 2022, year_max: 2023, neighbor_count: 6,
    evidence: ['E1', 'E2', 'E3'],
  }])
})

test('topic gaps: UAT/keyword terms frequent in neighbors, absent from members', () => {
  const { members, neighbors } = fixture()
  const result = analyzeGaps({ members, neighbors })
  assert.deepEqual(result.topic_gaps.map((g) => g.term), ['Gravitational waves', 'LIGO'])
  const gw = result.topic_gaps[0]
  assert.equal(gw.source, 'uat')
  assert.equal(gw.neighbor_count, 3)
  assert.deepEqual(gw.evidence, ['E1', 'E2', 'E4'])
  assert.equal(result.topic_gaps[1].source, 'keyword')
  // Member terms never surface as gaps.
  assert.ok(!result.topic_gaps.some((g) => g.term === 'Exoplanets' || g.term === 'transits'))
})

test('author bridges: frequent neighbor first authors absent from member authors', () => {
  const { members, neighbors } = fixture()
  const result = analyzeGaps({ members, neighbors })
  assert.deepEqual(result.author_gaps.map((g) => g.author), ['Fu, Mei', 'Gao, Lin'])
  assert.deepEqual(result.author_gaps[0].evidence, ['E1', 'E2', 'E4'])
})

test('single-member sets lower the link threshold to 1 (documented min(2, members))', () => {
  const members = [member('M1', 2015, { reference: ['E1'], citation: [] })]
  const neighbors = [neighbor('E1', 2022, 10)]
  const result = analyzeGaps({ members, neighbors })
  assert.deepEqual(result.candidates.map((c) => c.bibcode), ['E1'])
})

test('link lists are capped per member/direction and truncation is flagged', () => {
  const longList = Array.from({ length: GAP_LIMITS.MAX_LINKS_PER_MEMBER_DIRECTION + 5 }, (_, i) => `X${i}`)
  const members = [member('M1', 2015, { reference: longList, citation: [] })]
  const { counts, linksTruncated } = countNeighborLinks(members, new Set(['M1']), new Set())
  assert.ok(linksTruncated)
  assert.equal(counts.size, GAP_LIMITS.MAX_LINKS_PER_MEMBER_DIRECTION)
})

test('member bibcodes never appear as their own candidates', () => {
  const { members, neighbors } = fixture()
  members[0].reference.push('M2')
  const result = analyzeGaps({ members, neighbors })
  assert.ok(!result.candidates.some((c) => c.bibcode === 'M2'))
})
