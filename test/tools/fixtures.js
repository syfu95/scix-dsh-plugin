/**
 * Shared fixtures: realistic ADS Solr docs, LaTeXML HTML in BOTH native
 * arXiv and ar5iv shapes, one Semantic Scholar citations page, and exact
 * export texts (the export tests assert byte-for-byte passthrough).
 * All values are synthetic test data, not live API responses.
 */

/** arXiv paper with full body signals (EPRINT_HTML + DOI + identifier). */
export const docAtmos = {
  bibcode: '2021arXiv210301234X',
  title: ['A Study of Exoplanet Atmospheres'],
  author: ['Smith, Jane', 'Doe, John'],
  first_author: 'Smith, Jane',
  year: '2021',
  pubdate: '2021-03-00',
  pub: 'arXiv e-prints',
  abstract: 'We study exoplanet atmospheres and clouds with JWST-era methods. '.repeat(3),
  citation_count: 42,
  read_count: 120,
  doi: ['10.1051/0004-6361/202140001'],
  identifier: ['arXiv:2103.01234', '10.1051/0004-6361/202140001', '2021arXiv210301234X'],
  eid: 'arXiv:2103.01234',
  esources: ['EPRINT_HTML', 'EPRINT_PDF', 'ADS_OPENACCESS'],
  property: ['ARTICLE', 'EPRINT', 'OPENACCESS', 'REFEREED'],
  doctype: 'article',
  arxiv_class: ['astro-ph.EP'],
  keyword: ['Exoplanet atmospheres', 'Clouds'],
  keyword_norm: ['exoplanet atmospheres', 'clouds'],
  uat: ['Exoplanet atmospheres'],
  aff: ['MIT', 'Caltech'],
  fulltext_mtime: '2021-03-05T00:00:00Z',
}

/** Non-arXiv journal paper: publisher HTML only → no text route. */
export const docNonArxiv = {
  bibcode: '2020ApJ...890..123D',
  title: ['A Journal-Only Paper'],
  author: ['Roe, Richard'],
  first_author: 'Roe, Richard',
  year: '2020',
  pubdate: '2020-02-00',
  pub: 'The Astrophysical Journal',
  volume: '890',
  page: ['123'],
  abstract: 'Journal-only abstract.',
  citation_count: 10,
  doi: ['10.3847/1538-4357/ab0001'],
  identifier: ['10.3847/1538-4357/ab0001', '2020ApJ...890..123D'],
  esources: ['PUB_HTML'],
  property: ['ARTICLE', 'REFEREED'],
  doctype: 'article',
}

/** arXiv id only via identifier; no esources/property/fulltext signals. */
export const docArxivNoSignals = {
  bibcode: '2019arXiv190101234S',
  title: ['An Older Preprint'],
  author: ['Lee, Amy'],
  year: '2019',
  abstract: 'Older preprint abstract.',
  citation_count: 5,
  identifier: ['arXiv:1901.01234'],
  doctype: 'eprint',
}

/** Old-style arXiv bibcode (bibcode-parsing fallback path). */
export const docOldStyle = {
  bibcode: '2001astro.ph..1001S',
  title: ['An Old-Style Preprint'],
  author: ['Fox, Kim'],
  year: '2001',
  abstract: 'Old-style abstract.',
  citation_count: 3,
  doctype: 'eprint',
}

/** Citing papers for forward_citations / S2 matching. */
export const citingMethod = {
  bibcode: '2022A&A...650A..10F',
  title: ['Follow-up Methods Paper'],
  author: ['Fu, Mei'],
  year: '2022',
  citation_count: 8,
  doi: ['10.1051/0004-6361/202140002'],
  identifier: ['arXiv:2104.05678', '10.1051/0004-6361/202140002'],
  esources: ['EPRINT_HTML'],
  property: ['ARTICLE', 'EPRINT', 'REFEREED'],
  doctype: 'article',
}
export const citingBackground = {
  bibcode: '2023ApJ...940...55G',
  title: ['Background Context Paper'],
  author: ['Gao, Lin'],
  year: '2023',
  citation_count: 3,
  // Uppercase DOI: matching must normalize case (returned value stays verbatim).
  doi: ['10.3847/1538-4357/ABCD'],
  identifier: ['10.3847/1538-4357/ABCD'],
  doctype: 'article',
}
export const citingEmptyIntents = {
  bibcode: '2021arXiv210500001H',
  title: ['Matched But Unlabeled Paper'],
  author: ['Hu, Bo'],
  year: '2021',
  citation_count: 1,
  identifier: ['arXiv:2105.00001v2'],
  eid: 'arXiv:2105.00001',
  esources: ['EPRINT_HTML'],
  property: ['EPRINT'],
  doctype: 'eprint',
}
export const citingUnmatched = {
  bibcode: '2024MNRAS.520..777I',
  title: ['No S2 Match Paper'],
  author: ['Ito, Ren'],
  year: '2024',
  citation_count: 0,
  doi: ['10.1093/mnras/stae000'],
  doctype: 'article',
}

/** Semantic Scholar citations page (real response shape, synthetic values). */
export const s2Page = {
  offset: 0,
  next: null,
  data: [
    {
      citingPaper: { paperId: 's2hash1', title: 'Follow-up Methods Paper', externalIds: { DOI: '10.1051/0004-6361/202140002', ArXiv: '2104.05678' } },
      contexts: ['We use the method of Smith et al. (2021) to fit the transmission spectrum.'],
      intents: ['method'],
      isInfluential: true,
    },
    {
      citingPaper: { paperId: 's2hash2', title: 'Background Context Paper', externalIds: { DOI: '10.3847/1538-4357/abcd' } },
      contexts: [],
      intents: ['background'],
      isInfluential: false,
    },
    {
      citingPaper: { paperId: 's2hash3', title: 'Matched But Unlabeled Paper', externalIds: { ArXiv: '2105.00001' } },
      contexts: [],
      intents: [],
      isInfluential: false,
    },
  ],
}

/** Native arXiv HTML (arxiv.org/html) LaTeXML shape. */
export const htmlNativeArxiv = `<!DOCTYPE html>
<html lang="en">
<head><title>A Study of Exoplanet Atmospheres</title><script>var tracking = 1;</script></head>
<body>
<div class="ltx_page_main">
<div class="ltx_document">
<h1 class="ltx_title ltx_title_document">A Study of Exoplanet Atmospheres</h1>
<div class="ltx_authors"><span class="ltx_personname">Jane Smith</span></div>
<div class="ltx_abstract">
<h6 class="ltx_title ltx_title_abstract">Abstract</h6>
<p class="ltx_p">We study atmospheres &amp; clouds.</p>
</div>
<section id="S1" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2>
<div id="S1.p1" class="ltx_para">
<p class="ltx_p">Intro text with citation <cite class="ltx_cite">[1]</cite>.</p>
</div>
<section id="S1.SS1" class="ltx_subsection">
<h3 class="ltx_title ltx_title_subsection"><span class="ltx_tag ltx_tag_subsection">1.1 </span>Background</h3>
<div class="ltx_para"><p class="ltx_p">Background paragraph.</p></div>
</section>
</section>
<section id="S2" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">2 </span>Methods</h2>
<div class="ltx_para">
<p class="ltx_p">We fit <math class="ltx_Math" alttext="E=mc^{2}"><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E=mc^{2}</annotation></semantics></math> to the data.</p>
</div>
<figure class="ltx_figure">
<figcaption class="ltx_caption">Figure 1: pipeline.</figcaption>
</figure>
</section>
<section id="S3" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">3 </span>Results</h2>
<div class="ltx_para"><p class="ltx_p">Results paragraph one.</p></div>
<div class="ltx_para"><p class="ltx_p">Results paragraph two.</p></div>
</section>
<section id="bib" class="ltx_bibliography">
<h2 class="ltx_title ltx_title_bibliography">References</h2>
<ul class="ltx_biblist">
<li class="ltx_bibitem">Smith 2020, ApJ, 1</li>
</ul>
</section>
</div>
</div>
</body>
</html>`

/** ar5iv LaTeXML shape: div-based sections, numbered titles, appendix. */
export const htmlAr5iv = `<!DOCTYPE html>
<html>
<head><title>An Older Preprint</title><style>.ltx_page_main { margin: 0; }</style></head>
<body>
<div class="ltx_page_main">
<div class="ltx_document">
<h1 class="ltx_title ltx_title_document">An Older Preprint</h1>
<div class="ltx_abstract">
<h6 class="ltx_title ltx_title_abstract">Abstract</h6>
<p class="ltx_p">Older preprint abstract text.</p>
</div>
<div id="S1" class="ltx_section">
<h2 class="ltx_title ltx_title_section">1. Introduction</h2>
<div class="ltx_para"><p class="ltx_p">Ar5iv intro paragraph &ndash; with entity.</p></div>
</div>
<div id="S2" class="ltx_section">
<h2 class="ltx_title ltx_title_section">2. Methods</h2>
<div class="ltx_para"><p class="ltx_p">Ar5iv methods paragraph.</p></div>
<div id="S2.SS1" class="ltx_subsection">
<h3 class="ltx_title ltx_title_subsection">2.1. Fitting Procedure</h3>
<div class="ltx_para"><p class="ltx_p">Ar5iv fitting details.</p></div>
</div>
</div>
<div id="S3" class="ltx_section">
<h2 class="ltx_title ltx_title_section">3. Results and Discussion</h2>
<div class="ltx_para"><p class="ltx_p">Ar5iv results paragraph.</p></div>
</div>
<div id="A1" class="ltx_appendix">
<h2 class="ltx_title ltx_title_appendix">Appendix A. Derivations</h2>
<div class="ltx_para"><p class="ltx_p">Appendix derivation text.</p></div>
</div>
</div>
</div>
</body>
</html>`

/** Exact export texts — tests assert byte-for-byte passthrough of these. */
export const exportBibtex = `@ARTICLE{2021arXiv210301234X,
       author = {{Smith}, Jane and {Doe}, John},
        title = "{A Study of Exoplanet Atmospheres}",
      journal = {arXiv e-prints},
     keywords = {Astrophysics - Earth and Planetary Astrophysics},
         year = 2021,
        month = mar,
          eid = {arXiv:2103.01234},
       adsurl = {https://ui.adsabs.harvard.edu/abs/2021arXiv210301234X},
      adsnote = {Provided by the SAO/NASA Astrophysics Data System}
}
`

export const exportRis = `TY  - JOUR
AU  - Smith, Jane
AU  - Doe, John
TI  - A Study of Exoplanet Atmospheres
JO  - arXiv e-prints
PY  - 2021
DA  - 2021/03/01
DO  - 10.1051/0004-6361/202140001
ER  - 
`

export const exportAastex = `\\bibitem[Smith \\& Doe(2021)]{2021arXiv210301234X} Smith, J., \\& Doe, J.\\ 2021, arXiv e-prints, arXiv:2103.01234
`

/** Library metadata fixture (api-brief §7 LibraryMetadata shape). */
export const libraryMeta = {
  id: 'AbC123_-xYz',
  name: 'Exoplanet Reading List',
  description: 'JWST-era atmosphere papers',
  num_documents: 2,
  date_created: '2026-11-25T12:00:00Z',
  date_last_modified: '2026-11-25T12:00:00Z',
  permission: 'owner',
  owner: 'tester',
  public: false,
  num_users: 1,
}
