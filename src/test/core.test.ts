/*---------------------------------------------------------------------------------------------
 *  Atelier tests: identifiers and fingerprints, reading a model's JSON, ranking, the databases' records, merging.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStudyType, computeMeter, cosine, evidenceQuality, evidenceScore, fitKeywordWeight, heuristicScore, hybridCloseness, journalBonus, Judgment, KEYWORD_WEIGHT, keywordScores, normalize, rankScores, yearBonus } from '../core/scoring';
import { focusFullText, fullTextFromXml } from '../search/enrich';
import { formatReference, numberRanges, parseAuthor, plainReference, referenceList } from '../core/cite';
import { pdfDefinition, referencesBibtex, referencesRis, referencesText, synthesisTables, tablesCsv } from '../export';
import { CitedPaper, Query } from '../shared/api';
import { makeFingerprint, normalizeDoi, normalizePmcid, parseModelJson, safeInt, splitCitations, stripTags, tidyCitations, truncate } from '../core/text';
import { abstractFromInvertedIndex, normalizeCore, normalizeCrossref, normalizeEuropePmc, normalizeOpenAlex, normalizeSemanticScholar, parseArxivAtom, parsePubmedXml } from '../search/engines';
import { comprehensiveSearch, PaperSet, searchAll } from '../search/search';
import { Paper, Source } from '../shared/api';

const paper = (over: Partial<Paper>): Paper => ({ fingerprint: '', title: 'A title long enough to be compared with another', abstract: '', authors: [], journal: '', citationCount: 0, sources: ['pubmed'], ...over });

test('identifiers are normalized and the strongest one is the fingerprint', () => {
	assert.equal(normalizeDoi('https://doi.org/10.1000/ABC'), '10.1000/abc');
	assert.equal(normalizeDoi('doi:10.1000/x'), '10.1000/x');
	assert.equal(normalizePmcid('https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123'), 'PMC123');
	assert.equal(normalizePmcid('123'), 'PMC123');
	assert.equal(makeFingerprint({ doi: '10.1/A', pmid: '5', source: 'pubmed', sourceId: '5' }), 'doi:10.1/a');
	assert.equal(makeFingerprint({ pmid: '5', pmcid: 'PMC9', source: 'pubmed', sourceId: '5' }), 'pmid:5');
	assert.equal(makeFingerprint({ arxivId: '2101.00001', source: 'semanticscholar', sourceId: 'x' }), 'arxiv:2101.00001');
	assert.equal(makeFingerprint({ source: 'openalex', sourceId: 'W1' }), 'openalex:W1');
});

test('text helpers', () => {
	assert.equal(safeInt('2021 Jan-Feb'), 2021);
	assert.equal(safeInt('42'), 42);
	assert.equal(safeInt(''), undefined);
	assert.equal(truncate('a  b\nc', 100), 'a b c');
	assert.equal(truncate('abcdefghij', 8), 'abcde...');
	assert.equal(stripTags('H<sub>2</sub>O &amp; <i>E. coli</i> &#233;&#xe9;'), 'H2O & E. coli éé');
	assert.equal(splitCitations('seen [1, 2] and [3;4] but [5] and [a, b]'), 'seen [1][2] and [3][4] but [5] and [a, b]');
});

test('a model\'s JSON is found inside fences and after its thinking', () => {
	assert.deepEqual(parseModelJson('<think>hmm {"no": 1}</think>\n```json\n{"intent": "SEARCH"}\n```'), { intent: 'SEARCH' });
	assert.deepEqual(parseModelJson('Here you go: {"a": {"b": 2}} done'), { a: { b: 2 } });
	assert.throws(() => parseModelJson('no json here'));
	assert.throws(() => parseModelJson('[1, 2]'));
});

test('study types are read from the title before the abstract', () => {
	assert.equal(classifyStudyType('Mammography uptake: a systematic review and meta-analysis', ''), 'systematic review / meta-analysis');
	assert.equal(classifyStudyType('A cluster-randomised trial of text reminders', ''), 'randomized controlled trial');
	assert.equal(classifyStudyType('Barriers to screening', 'We did in-depth interviews with 30 women.'), 'qualitative study');
	assert.equal(classifyStudyType('A cross-sectional survey', 'Unlike a randomized trial, ...'), 'cross-sectional study');
	assert.equal(classifyStudyType('Thoughts', 'An essay.'), 'unspecified');
});

test('ranking: closeness scaled to the best paper, plus the heuristics', () => {
	assert.equal(yearBonus(1990, 2026), 0);
	assert.equal(yearBonus(2026, 2026), 1);
	const review = heuristicScore({ citationCount: 0, year: undefined, sourceCount: 1, studyType: 'systematic review / meta-analysis' });
	const plain = heuristicScore({ citationCount: 0, year: undefined, sourceCount: 1, studyType: 'unspecified' });
	assert.equal(review, 5);
	assert.equal(plain, 0);
	assert.equal(heuristicScore({ citationCount: 0, sourceCount: 3, studyType: 'unspecified' }), 2.5);
	// not screened: closeness alone, plus quality
	assert.deepEqual(rankScores([0.8, 0.4], [undefined, undefined], [0, 5]), [100, 53.5]);
	// screened: what the AI said of the paper against the question decides; quality adds at most 10
	assert.deepEqual(rankScores([1, 1], [90, 10], [0, 20]), [92.5, 42.5]);
	// a famous off-topic paper never passes an obscure on-topic one
	const [onTopic, famous] = rankScores([0.6, 1], [80, 30], [0, 14]);
	assert.ok(onTopic > famous);
});

test('vectors: unit length and cosine', () => {
	const a = normalize([3, 4]);
	assert.ok(Math.abs(cosine(a, a) - 1) < 1e-6);
	assert.ok(Math.abs(cosine(a, normalize([-4, 3]))) < 1e-6);
	assert.deepEqual([...normalize([0, 0])], [0, 0]);
});

test('keyword ranking prefers the document about the query', () => {
	const scores = keywordScores('breast cancer screening barriers', [
		'Barriers to breast cancer screening among rural women',
		'Maize yields under drought',
		'Cancer registries in Africa'
	]);
	assert.ok(scores[0] > scores[2] && scores[2] > scores[1]);
	assert.equal(scores[1], 0);
});

test('PubMed XML: markup in titles, labelled abstracts, ids, authors, years', () => {
	const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID Version="1">123</PMID><Article>
		<Journal><JournalIssue><PubDate><MedlineDate>2021 Jan-Feb</MedlineDate></PubDate></JournalIssue><Title>The Journal</Title></Journal>
		<ArticleTitle>Effect of H<sub>2</sub>O on <i>E. coli</i> &amp; friends.</ArticleTitle>
		<ELocationID EIdType="pii">S1</ELocationID><ELocationID EIdType="doi">10.1000/XYZ</ELocationID>
		<Abstract><AbstractText Label="BACKGROUND">Water matters.</AbstractText><AbstractText Label="RESULTS">It <b>did</b>.</AbstractText></Abstract>
		<AuthorList><Author><LastName>Newman</LastName><ForeName>Lisa A</ForeName><Initials>LA</Initials></Author><Author><CollectiveName>The Study Group</CollectiveName></Author></AuthorList>
		</Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">123</ArticleId><ArticleId IdType="pmc">PMC77</ArticleId></ArticleIdList></PubmedData></PubmedArticle>
		<PubmedArticle><MedlineCitation><PMID>9</PMID><Article><ArticleTitle></ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
	const papers = parsePubmedXml(xml);
	assert.equal(papers.length, 1);
	const [p] = papers;
	assert.equal(p.title, 'Effect of H2O on E. coli & friends.');
	assert.equal(p.abstract, 'BACKGROUND: Water matters.\n\nRESULTS: It did.');
	assert.deepEqual(p.authors, ['Lisa A Newman', 'The Study Group']);
	assert.equal(p.fingerprint, 'doi:10.1000/xyz');
	assert.equal(p.pmid, '123');
	assert.equal(p.pmcid, 'PMC77');
	assert.equal(p.year, 2021);
	assert.equal(p.journal, 'The Journal');
	assert.deepEqual(parsePubmedXml('not xml <'), []);
});

test('Europe PMC, OpenAlex and Semantic Scholar records', () => {
	const epmc = normalizeEuropePmc({ id: '55', source: 'MED', title: 'A study.', authorString: 'Smith J, Doe A.', pubYear: '2020', citedByCount: 7, pmcid: 'PMC1', abstractText: '<h4>Aim</h4>To see.', fullTextUrlList: { fullTextUrl: [{ url: 'https://a/html', documentStyle: 'html' }, { url: 'https://a/pdf', documentStyle: 'pdf' }] } });
	assert.equal(epmc.fingerprint, 'pmid:55');
	assert.equal(epmc.title, 'A study');
	assert.deepEqual(epmc.authors, ['Smith J', 'Doe A']);
	assert.equal(epmc.abstract, 'AimTo see.');
	assert.equal(epmc.pdfUrl, 'https://a/pdf');
	assert.equal(epmc.fullTextUrl, 'https://a/html');
	assert.equal(epmc.citationCount, 7);

	assert.equal(abstractFromInvertedIndex({ screening: [1], Cancer: [0], works: [2, 4], and: [3] }), 'Cancer screening works and works');
	const oa = normalizeOpenAlex({ id: 'https://openalex.org/W1', display_name: 'Work', ids: { doi: 'https://doi.org/10.5/Q', pmid: 'https://pubmed.ncbi.nlm.nih.gov/88' }, publication_year: 2019, cited_by_count: 3, authorships: [{ author: { display_name: 'A B' } }], abstract_inverted_index: { Hello: [0], world: [1] } });
	assert.equal(oa.fingerprint, 'doi:10.5/q');
	assert.equal(oa.pmid, '88');
	assert.equal(oa.abstract, 'Hello world');
	assert.equal(oa.fullTextUrl, 'https://doi.org/10.5/q');

	const s2 = normalizeSemanticScholar({ paperId: 'abc', title: 'Preprint', externalIds: { ArXiv: '2101.00001' }, year: 2021, authors: [{ name: 'C D' }], citationCount: 2 });
	assert.equal(s2.fingerprint, 'arxiv:2101.00001');
	assert.equal(s2.abstract, '');
});

test('the same paper from two databases is one paper, with the details of both', () => {
	const set = new PaperSet();
	assert.equal(set.add(paper({ fingerprint: 'pmid:1', pmid: '1', year: 2020, abstract: 'short' })), true);
	// no identifier in common: the title and year say it is the same
	assert.equal(set.add(paper({ fingerprint: 'doi:10.1/a', doi: '10.1/a', year: 2020, abstract: 'a longer abstract', citationCount: 12, sources: ['openalex'] })), false);
	// and now its DOI finds it
	assert.equal(set.add(paper({ fingerprint: 'doi:10.1/a', doi: '10.1/a', title: 'Titled differently in this database, as happens', pdfUrl: 'https://pdf', sources: ['semanticscholar'] })), false);
	assert.equal(set.add(paper({ fingerprint: 'pmid:2', pmid: '2', title: 'Another paper altogether, on another subject', year: 2020 })), true);
	const [merged, other] = set.finish();
	assert.equal(merged.fingerprint, 'doi:10.1/a');
	assert.equal(merged.abstract, 'a longer abstract');
	assert.equal(merged.citationCount, 12);
	assert.equal(merged.pdfUrl, 'https://pdf');
	assert.deepEqual(merged.sources, ['pubmed', 'openalex', 'semanticscholar']);
	assert.equal(other.fingerprint, 'pmid:2');
});

test('a search asks the databases in the plan, survives one failing, and keeps a stored paper\'s fingerprint', async () => {
	const engine = (source: Source, result: Paper[] | Error) => ({ source, search: async () => { if (result instanceof Error) { throw result; } return result; } });
	const reports: string[] = [];
	const papers = await comprehensiveSearch(
		[
			engine('pubmed', [paper({ fingerprint: 'doi:10.1/a', doi: '10.1/a', pmid: '1' })]),
			engine('europepmc', new Error('down')),
			engine('openalex', [paper({ fingerprint: 'openalex:W9', title: 'Something else entirely, from OpenAlex', sources: ['openalex'] })]),
			engine('semanticscholar', [paper({ fingerprint: 'x' })])
		],
		{ pubmed: ['q'], europepmc: ['q'], openalex: ['q'], semanticscholar: ['null'] },
		20,
		[paper({ fingerprint: 'pmid:1', pmid: '1', sources: ['atelier'] })],
		undefined,
		results => reports.push(results.map(r => `${r.source}:${r.error ?? r.count ?? '...'}`).join(' '))
	);
	assert.deepEqual(papers.map(p => p.fingerprint), ['pmid:1', 'openalex:W9']);
	assert.deepEqual(papers[0].sources, ['atelier', 'pubmed']);
	assert.equal(papers[0].doi, '10.1/a');
	assert.equal(reports[0], 'pubmed:... europepmc:... openalex:...');
	assert.equal(reports.at(-1), 'pubmed:1 europepmc:down openalex:1');
});

test('the Atelier Meter weighs each paper by its evidence tier and citations', () => {
	// too few papers taking a side say nothing
	assert.equal(computeMeter([{ stance: 'yes', studyType: 'cohort study', citationCount: 0 }, { stance: 'no', studyType: 'cohort study', citationCount: 0 }, { studyType: 'cohort study', citationCount: 0 }]), undefined);
	// a meta-analysis (5) saying yes outweighs two case reports (1 each, the floor) saying no
	const meter = computeMeter([
		{ stance: 'yes', studyType: 'systematic review / meta-analysis', citationCount: 0 },
		{ stance: 'no', studyType: 'case report / case series', citationCount: 0 },
		{ stance: 'no', studyType: 'case report / case series', citationCount: 0 },
		{ studyType: 'randomized controlled trial', citationCount: 500 }
	]);
	assert.deepEqual(meter, { yes: 71, possibly: 0, mixed: 0, no: 29, papers: 3 });
	// the shares always add up to 100
	const thirds = computeMeter(['yes', 'possibly', 'mixed'].map(stance => ({ stance: stance as 'yes', studyType: 'unspecified', citationCount: 0 })))!;
	assert.equal(thirds.yes + thirds.possibly + thirds.mixed + thirds.no, 100);
	assert.equal(thirds.no, 0);
});

test('full text: the body\'s prose, without tables, figures and references', () => {
	const xml = `<article><front><abstract><p>Abstract here.</p></abstract></front><body>
		<sec><title>Methods</title><p>We enrolled 1,200 women <xref ref-type="bibr">[1]</xref> in <italic>Kisumu</italic>.</p>
		<table-wrap><table><tr><td><p>cell</p></td></tr></table></table-wrap>
		<fig><caption><p>A figure.</p></caption></fig></sec>
		<sec><title>Results</title><p>Uptake rose to 41&#x25;.</p></sec></body>
		<back><ref-list><ref><p>A reference.</p></ref></ref-list></back></article>`;
	assert.equal(fullTextFromXml(xml), 'METHODS\nWe enrolled 1,200 women in Kisumu.\n\nRESULTS\nUptake rose to 41%.');
	assert.equal(fullTextFromXml('<article><front/></article>'), '');
});

test('hybrid closeness blends meaning and keywords, each spread over the candidates', () => {
	// similarities in a narrow band still separate the papers
	assert.deepEqual(hybridCloseness([0.8, 0.7, 0.6], [0, 0, 0]).map(value => Math.round(value * 1000) / 1000), [1, 0.5, 0]);
	// a paper that names the exact words gains on one that is only close in meaning
	const [a, b] = hybridCloseness([0.8, 0.78, 0.6], [0, 4, 2]);
	assert.ok(b > a);
	// meaning still decides between papers the keywords can't tell apart
	const [c, d] = hybridCloseness([0.8, 0.6], [3, 3]);
	assert.ok(c > d);
	assert.deepEqual(hybridCloseness([], []), []);
});

test('a well-cited journal adds to a paper\'s score, up to a point', () => {
	assert.equal(journalBonus(undefined), 0);
	assert.ok(journalBonus(11.5) > journalBonus(2.6) && journalBonus(2.6) > 0);
	assert.equal(journalBonus(500), 2);
	const base = { citationCount: 0, sourceCount: 1, studyType: 'unspecified' };
	assert.ok(heuristicScore({ ...base, journalImpact: 11.5 }) > heuristicScore(base));
});

test('the keyword weight is fitted on what the screenings found relevant', () => {
	// too few judgments: the default
	assert.equal(fitKeywordWeight([[1, 0, 1], [0, 1, 0]]), KEYWORD_WEIGHT);
	// relevance followed the keywords, and meaning said nothing: keywords get their most
	const byWords: Judgment[] = Array.from({ length: 200 }, (_x, i) => [((i * 37) % 100) / 100, i % 2 ? 0.9 - (i % 7) / 100 : 0.1 + (i % 7) / 100, i % 2 ? 1 : 0]);
	assert.equal(fitKeywordWeight(byWords), 0.6);
	// relevance followed meaning, and the keywords were noise: they get none
	const byMeaning: Judgment[] = Array.from({ length: 200 }, (_x, i) => [i % 2 ? 0.61 - (i % 7) / 100 : 0.39 + (i % 7) / 100, ((i * 37) % 100) / 100, i % 2 ? 1 : 0]);
	assert.equal(fitKeywordWeight(byMeaning), 0);
	// only one kind of judgment tells nothing
	assert.equal(fitKeywordWeight(Array.from({ length: 200 }, (): Judgment => [0.5, 0.5, 1])), KEYWORD_WEIGHT);
});

test('citations keep their numbers; a run of them is put in ascending order', () => {
	assert.equal(tidyCitations('Many factors matter [13][20][1]. Fear deters [2, 1] and [20]. Then [3] [3][1].'), 'Many factors matter [1][13][20]. Fear deters [1][2] and [20]. Then [1][3].');
	assert.equal(tidyCitations('No citations.'), 'No citations.');
});

test('references are ordered by evidence: how directly a paper answers, then how strong a study it is', () => {
	const review = evidenceQuality({ studyType: 'systematic review / meta-analysis', citationCount: 0 });
	const crossSectional = evidenceQuality({ studyType: 'cross-sectional study', citationCount: 26, journalImpact: 3.5 });
	const caseReport = evidenceQuality({ studyType: 'case report / case series', citationCount: 0 });
	// answering equally, the stronger design comes first -- a new meta-analysis before a cited cross-sectional study
	assert.ok(evidenceScore(88, review) > evidenceScore(88, crossSectional));
	assert.ok(evidenceScore(88, crossSectional) > evidenceScore(88, caseReport));
	// between two of the same design, the more cited, and the better journal
	assert.ok(evidenceQuality({ studyType: 'cohort study', citationCount: 300 }) > evidenceQuality({ studyType: 'cohort study', citationCount: 3 }));
	assert.ok(evidenceQuality({ studyType: 'cohort study', citationCount: 0, journalImpact: 20 }) > evidenceQuality({ studyType: 'cohort study', citationCount: 0 }));
	// a strong study that answers less directly doesn't pass a weak one that answers much more directly
	assert.ok(evidenceScore(90, caseReport) > evidenceScore(75, review));
	// quality adds at most 10
	assert.equal(evidenceQuality({ studyType: 'systematic review / meta-analysis', citationCount: 100000, journalImpact: 500 }), 10);
	assert.equal(evidenceScore(80, 1000), 90);
});

const cited = (over: Partial<CitedPaper>): CitedPaper => ({ ...paper({}), studyType: 'cohort study', score: 90, ...over });
const report: Query = {
	id: 'q', prompt: 'Does it work?', route: 'search', model: 'A model', createdAt: 0, candidates: 80, read: 22, ranking: 'embeddings',
	meter: { yes: 70, possibly: 0, mixed: 10, no: 20, papers: 2 },
	synthesis: 'It **works** [1][2].\n\n### Key Factors\n\n| Factor | Evidence | Sources |\n|---|---|---|\n| **Cost** | Fees deter, *often* | [1] |\n| Distance | Short row |\n\n- A point [2]',
	papers: [
		cited({ fingerprint: 'doi:10.1/a', doi: '10.1/a', title: 'A trial of things.', authors: ['Ann Lee', 'Bo Chan', 'C D', 'E F', 'G H', 'I J', 'K L'], journal: 'The Journal', year: 2021, abstract: 'An abstract.', extraction: { isRelevant: true, relevance: 90, answer: 'It works.', population: 'Adults', methods: '-', results: 'Better', outcomes: 'Uptake', sampleSize: '1200', studyCount: '-', duration: '-', country: 'Kenya', stance: 'yes' } }),
		cited({ fingerprint: 'pmid:7', pmid: '7', title: 'Costs & benefits', authors: ['Zed Omondi'], journal: '', studyType: 'unspecified' })
	]
};

test('references: the formatted list, RIS and BibTeX', () => {
	assert.equal(plainReference(formatReference(report.papers[0], 'vancouver')), 'Lee A, Chan B, D C, F E, H G, J I, et al. A trial of things. The Journal. 2021. doi:10.1/a');
	assert.equal(referencesText(report), '1. Lee A, Chan B, D C, F E, H G, J I, et al. A trial of things. The Journal. 2021. doi:10.1/a\r\n2. Omondi Z. Costs & benefits. https://pubmed.ncbi.nlm.nih.gov/7/\r\n');
	const ris = referencesRis(report);
	assert.ok(ris.startsWith('TY  - JOUR\r\nTI  - A trial of things.\r\nAU  - Ann Lee\r\nAU  - Bo Chan'));
	assert.equal(ris.match(/^ER  - $/gm)?.length, 2);
	assert.ok(ris.includes('DO  - 10.1/a') && ris.includes('AN  - 7'));
	const bib = referencesBibtex(report);
	assert.ok(bib.includes('@article{lee2021_1,') && bib.includes('author = {Ann Lee and Bo Chan'));
	assert.ok(bib.includes('@article{omondi_2,') && bib.includes('title = {{Costs \\& benefits}}'));
});

test('tables: the synthesis\'s, under their headings, and the evidence table', () => {
	assert.deepEqual(synthesisTables(report.synthesis), [{ title: 'Key Factors', header: ['Factor', 'Evidence', 'Sources'], rows: [['Cost', 'Fees deter, often', '[1]'], ['Distance', 'Short row', '']] }]);
	const csv = tablesCsv(report);
	assert.ok(csv.startsWith('\ufeffKey Factors\r\nFactor,Evidence,Sources\r\nCost,"Fees deter, often",[1]\r\n'));
	assert.ok(csv.includes('\r\n\r\nEvidence table\r\n#,Paper,Authors,'));
	assert.ok(csv.includes('1,A trial of things.,'));
});

test('the PDF report: the window\'s font and accent, paragraphs justified, references written out', () => {
	const definition = pdfDefinition(report, 'The topic', { theme: { accent: '#0a6e5c' } }, 'Segoe UI') as any;
	assert.equal(definition.defaultStyle.font, 'Segoe UI');
	assert.equal(definition.styles.p.alignment, 'justify');
	const all = JSON.stringify(definition.content);
	// the title, the meter, the synthesis's heading in capitals, the table's header in the window's accent
	assert.ok(all.includes('"Does it work?"') && all.includes('Atelier Meter') && all.includes('KEY FACTORS') && all.includes('#0a6e5c'));
	// citations are written, not badges; the references are a written list, not cards
	assert.ok(!all.includes('"background":"#d4a94a"') && !all.includes('"01"'));
	assert.ok(all.includes('"References"') && all.includes('Lee A, Chan B,') && all.includes('doi:10.1/a'));
	// a short row is filled out to the table's width
	const table = definition.content.find((block: any) => block.table?.headerRows === 1);
	assert.ok(table.table.body.every((row: unknown[]) => row.length === 3));
});

test('the PDF report has the evidence table when the table is what is selected, of the papers shown', () => {
	const text = (options: Parameters<typeof pdfDefinition>[2]) => JSON.stringify((pdfDefinition(report, 'The topic', options) as any).content);
	assert.ok(!text({ view: 'list' }).includes('Evidence table'));
	const table = text({ view: 'table' });
	assert.ok(table.includes('Evidence table') && table.includes('"POPULATION"') && table.includes('"SAYS"') && table.includes('Adults') && table.includes('"REF."'));
	// filtered and sorted: only what is shown, in that order; the references are still all written out
	const filtered = text({ view: 'table', shown: [2, 99, 0] });
	assert.ok(filtered.includes('1 of the 2 references, as filtered.') && !filtered.includes('Adults') && filtered.includes('Lee A, Chan B,'));
	const sorted = text({ view: 'table', shown: [2, 1] });
	assert.ok(sorted.indexOf('Costs & benefits') < sorted.indexOf('A trial of things'));
	// an author-year style has no reference numbers to show in the table
	assert.ok(!text({ view: 'table', style: 'apa' }).includes('"REF."'));
});

test('authors are read as family name and initials, however a database writes them', () => {
	assert.deepEqual(parseAuthor('Lisa A Newman'), { family: 'Newman', initials: 'LA' });
	assert.deepEqual(parseAuthor('Newman LA'), { family: 'Newman', initials: 'LA' });
	assert.deepEqual(parseAuthor('Newman, Lisa A.'), { family: 'Newman', initials: 'LA' });
	assert.deepEqual(parseAuthor('Ludwig van Beethoven'), { family: 'van Beethoven', initials: 'L' });
	assert.deepEqual(parseAuthor('Jean-Paul Sartre'), { family: 'Sartre', initials: 'JP' });
	assert.deepEqual(parseAuthor('WHO Collaborative Study Group'), { family: 'WHO Collaborative Study Group', initials: '' });
	assert.deepEqual(parseAuthor('Plato'), { family: 'Plato', initials: '' });
});

test('a reference in each citation style', () => {
	const one = { title: 'Barriers to screening.', authors: ['Lisa A Newman', 'Doe J', 'Amina Otieno'], journal: 'The Lancet', year: 2022, doi: '10.1/x' };
	assert.equal(plainReference(formatReference(one, 'vancouver')), 'Newman LA, Doe J, Otieno A. Barriers to screening. The Lancet. 2022. doi:10.1/x');
	assert.equal(plainReference(formatReference(one, 'apa')), 'Newman, L. A., Doe, J., & Otieno, A. (2022). Barriers to screening. The Lancet. https://doi.org/10.1/x');
	assert.equal(plainReference(formatReference(one, 'harvard')), "Newman, L.A., Doe, J. and Otieno, A. (2022) 'Barriers to screening', The Lancet. doi:10.1/x.");
	assert.equal(plainReference(formatReference(one, 'ieee')), 'L. A. Newman, J. Doe, and A. Otieno, "Barriers to screening," The Lancet, 2022, doi: 10.1/x.');
	assert.equal(plainReference(formatReference(one, 'ama')), 'Newman LA, Doe J, Otieno A. Barriers to screening. The Lancet. 2022. doi:10.1/x');
	assert.deepEqual(formatReference(one, 'ama').filter(segment => segment.italics).map(segment => segment.text), ['The Lancet']);
	// the journal is what a style sets in italics
	assert.deepEqual(formatReference(one, 'apa').filter(segment => segment.italics).map(segment => segment.text), ['The Lancet']);
	assert.equal(formatReference(one, 'vancouver').some(segment => segment.italics), false);
	assert.equal(plainReference(formatReference({ ...one, authors: ['Kim Park', 'Li Wei'] }, 'apa')), 'Park, K., & Wei, L. (2022). Barriers to screening. The Lancet. https://doi.org/10.1/x');
	// no authors, no year
	assert.equal(plainReference(formatReference({ title: 'A report', authors: [], journal: '' }, 'apa')), '(n.d.). A report.');
});

test('a style cites by number or by author and year, and lists its references to match', () => {
	const papers = [
		{ title: 'Zebra study', authors: ['Zed Omondi'], journal: 'J', year: 2019 },
		{ title: 'Second of the year', authors: ['Ann Lee', 'Bo Chan', 'C D'], journal: 'J', year: 2021 },
		{ title: 'First of the year', authors: ['Ann Lee', 'Bo Chan', 'E F'], journal: 'J', year: 2021 },
		{ title: 'Two authors', authors: ['Kim Park', 'Li Wei'], journal: 'J', year: 2020 }
	];
	const numbered = referenceList(papers, 'vancouver');
	assert.deepEqual(numbered.entries.map(entry => entry.n), [1, 2, 3, 4]);
	// by number, each style its own way: in parentheses, raised, in square brackets -- three in a row as a range
	assert.equal(numbered.cite([1, 3]), '(1, 3)');
	assert.equal(numbered.cite([5, 1, 2, 3, 3, 9, 10]), '(1\u20133, 5, 9, 10)');
	const ama = referenceList(papers, 'ama');
	assert.equal(ama.cite([4, 2, 3, 1]), '1-4');
	assert.equal(ama.cite([1, 3]), '1,3');
	assert.ok(ama.superscript && !numbered.superscript);
	assert.equal(referenceList(papers, 'ieee').cite([1, 2, 3, 5]), '[1]\u2013[3], [5]');
	assert.equal(numberRanges([], '-', ','), '');
	const apa = referenceList(papers, 'apa');
	// by author; the two alike in authors and year lettered in the list's order
	assert.deepEqual(apa.entries.map(entry => entry.n), [2, 3, 1, 4]);
	assert.ok(plainReference(apa.entries[0].segments).includes('(2021a). Second of the year'));
	assert.ok(plainReference(apa.entries[1].segments).includes('(2021b). First of the year'));
	assert.equal(apa.cite([1]), '(Omondi, 2019)');
	assert.equal(apa.cite([2, 3, 4]), '(Lee et al., 2021a; Lee et al., 2021b; Park & Wei, 2020)');
	assert.equal(referenceList(papers, 'harvard').cite([4]), '(Park and Wei, 2020)');
	// a number that is no paper's is left as written
	assert.equal(apa.cite([9]), '[9]');
});

test('the PDF report cites in its text as the citation style writes citations', () => {
	const text = (style: 'vancouver' | 'ama' | 'ieee' | 'apa' | 'harvard') => JSON.stringify((pdfDefinition(report, 'The topic', { style }) as any).content);
	// "It works [1][2]." in each style
	assert.ok(text('vancouver').includes('"text":"(1, 2)"') && text('vancouver').includes('Lee A, Chan B,'));
	// raised, against the word before it
	const ama = text('ama');
	// raised, against the word before it and after its full stop; on the line where a table cell holds nothing else
	assert.ok(ama.includes('"text":"works"},{"text":"."},{"text":"1,2","sup":true}') && ama.includes('"italics":true'));
	assert.ok(ama.includes('[{"text":"1"}]') && ama.includes('{"text":"2","sup":true}'));
	assert.ok(text('ieee').includes('"text":"[1], [2]"') && text('ieee').includes('"text":"[1]"'));
	const apa = text('apa');
	assert.ok(apa.includes('(Lee et al., 2021; Omondi, n.d.)') && apa.includes('"italics":true') && apa.includes('Lee, A., Chan, B.,') && apa.includes('"leadingIndent":-18'));
	assert.ok(text('harvard').includes('(Lee et al., 2021; Omondi, n.d.)'));
	assert.equal(referencesText(report, 'apa').split('\r\n\r\n').length, 2);
});

test('of a long full text, the methods and results are what the AI is given first', () => {
	const section = (heading: string, body: string, length: number) => `${heading}\n${body.repeat(Math.ceil(length / body.length)).slice(0, length)}`;
	const paperText = [section('INTRODUCTION', 'Background words. ', 5000), section('METHODS', 'We enrolled 1,204 women. ', 3000), section('RESULTS', 'Uptake was 16.6%. ', 3000), section('DISCUSSION', 'This means things. ', 4000)].join('\n\n');
	assert.equal(focusFullText(paperText, 100000), paperText);
	const focused = focusFullText(paperText, 7000);
	assert.ok(focused.length <= 7000);
	// the methods and results whole, in the paper's order; the introduction is what gives way
	assert.ok(focused.includes(section('METHODS', 'We enrolled 1,204 women. ', 3000)) && focused.includes(section('RESULTS', 'Uptake was 16.6%. ', 3000)));
	assert.ok(!focused.includes('INTRODUCTION') && focused.indexOf('METHODS') < focused.indexOf('RESULTS'));
});

test('Crossref, CORE and arXiv records', () => {
	const crossref = normalizeCrossref({ DOI: '10.5/ABC', title: ['Resettlement and <i>livelihoods</i>'], author: [{ given: 'Michael', family: 'Cernea' }, { name: 'World Bank' }], 'container-title': ['World Development'], issued: { 'date-parts': [[1997, 10]] }, abstract: '<jats:p>Displacement impoverishes.</jats:p>', 'is-referenced-by-count': 900 });
	assert.equal(crossref.fingerprint, 'doi:10.5/abc');
	assert.equal(crossref.title, 'Resettlement and livelihoods');
	assert.deepEqual(crossref.authors, ['Michael Cernea', 'World Bank']);
	assert.equal(crossref.abstract, 'Displacement impoverishes.');
	assert.equal(crossref.year, 1997);
	assert.equal(crossref.citationCount, 900);
	assert.deepEqual(crossref.sources, ['crossref']);

	const core = normalizeCore({ id: 42, title: 'A county land report', authors: [{ name: 'Lesorogol, Carolyn' }], yearPublished: 2008, publisher: 'A University', downloadUrl: 'https://core.ac.uk/download/42.pdf', abstract: 'Land values.', journals: [] });
	assert.equal(core.fingerprint, 'core:42');
	assert.equal(core.journal, 'A University');
	assert.equal(core.pdfUrl, 'https://core.ac.uk/download/42.pdf');
	assert.deepEqual(core.authors, ['Lesorogol, Carolyn']);

	const arxiv = parseArxivAtom(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
		<entry><id>http://arxiv.org/abs/2101.00001v3</id><published>2021-01-01T00:00:00Z</published><title>Graph networks
		 for molecules</title><summary>We study graphs.</summary><author><name>Ada Lovelace</name></author><author><name>Alan Turing</name></author>
		<arxiv:doi>10.1000/J.X</arxiv:doi><link href="http://arxiv.org/abs/2101.00001v3" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/2101.00001v3" rel="related" type="application/pdf"/></entry>
		<entry><id>http://arxiv.org/abs/2202.00002v1</id><title></title></entry></feed>`);
	assert.equal(arxiv.length, 1);
	assert.equal(arxiv[0].title, 'Graph networks for molecules');
	assert.equal(arxiv[0].fingerprint, 'doi:10.1000/j.x');
	assert.equal(arxiv[0].fullTextUrl, 'https://arxiv.org/abs/2101.00001');
	assert.equal(arxiv[0].pdfUrl, 'http://arxiv.org/pdf/2101.00001v3');
	assert.deepEqual(arxiv[0].authors, ['Ada Lovelace', 'Alan Turing']);
	assert.equal(arxiv[0].year, 2021);
	assert.deepEqual(parseArxivAtom('<not atom'), []);
});

test('a database is asked each of its queries, its papers shared among them; one query failing is not the database failing', async () => {
	const asked: string[] = [];
	const engine = (source: Source, fail?: string) => ({
		source,
		search: async (query: string, limit: number) => {
			asked.push(`${source}:${query}:${limit}`);
			if (query === fail) { throw new Error('busy'); }
			return [paper({ fingerprint: `${source}:${query}`, title: `A paper found by ${source} for the query ${query}`, sources: [source] })];
		}
	});
	let last = '';
	const all = await searchAll([engine('pubmed'), engine('openalex', 'b'), engine('crossref', 'z')], { pubmed: ['a'], openalex: ['a', 'b', 'a', ' '], crossref: ['z'], core: ['unasked'] }, 20, undefined,
		results => { last = results.map(r => `${r.source}:${r.error ?? r.count ?? '...'}`).join(' '); });
	// one query: the whole limit; two: half as many again, shared; a repeated or empty query is not asked
	assert.deepEqual(asked.sort(), ['crossref:z:20', 'openalex:a:15', 'openalex:b:15', 'pubmed:a:20']);
	assert.deepEqual(all.map(p => p.fingerprint), ['pubmed:a', 'openalex:a']);
	assert.equal(last, 'pubmed:1 openalex:1 crossref:busy');
	// what is new to a pool is told apart from what it has
	const pool = new PaperSet();
	assert.equal(pool.addAll(all).length, 2);
	assert.equal(pool.addAll(all).length, 0);
});
