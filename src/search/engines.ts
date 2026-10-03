/*---------------------------------------------------------------------------------------------
 *  Atelier: the academic databases -- PubMed (NCBI E-utilities), Europe PMC, OpenAlex and Semantic Scholar. Each
 *  takes a query and answers with Papers in the one shape Atelier knows. No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

import { XMLParser } from 'fast-xml-parser';
import { Paper, Source } from '../shared/api';
import { cleanText, makeFingerprint, normalizeDoi, normalizePmcid, normalizePmid, safeInt, splitAuthors, stripTags } from '../core/text';
import { HttpClient } from './http';

export interface Engine {
	readonly source: Source;
	search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]>;
}

export interface EngineOptions {
	readonly userAgent: string;
	/** Sent to NCBI and OpenAlex, which ask tools to say who they are. */
	readonly email?: string;
	readonly ncbiApiKey?: string;
	readonly openAlexApiKey?: string;
	readonly semanticScholarApiKey?: string;
	readonly coreApiKey?: string;
}

type Json = Record<string, any>;

// ---- PubMed: ESearch for the ids, EFetch for their records (XML)

const pubmedXml = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	parseTagValue: false,
	parseAttributeValue: false,
	htmlEntities: true,
	// titles and abstracts carry markup (<i>, <sup>): taken as they are written, and stripped
	stopNodes: ['*.ArticleTitle', '*.AbstractText'],
	isArray: name => ['PubmedArticle', 'AbstractText', 'Author', 'ELocationID', 'ArticleId'].includes(name)
});

/** An element's text, whether it was read as text or (having attributes) as an object. */
function text(node: unknown): string | undefined {
	if (node === undefined || node === null) {
		return undefined;
	}
	const value = typeof node === 'object' ? (node as Json)['#text'] : node;
	return value === undefined || value === null ? undefined : stripTags(String(value)) || undefined;
}

/** The records of an EFetch answer. */
export function parsePubmedXml(xml: string): Paper[] {
	let articles: Json[];
	try {
		articles = pubmedXml.parse(xml)?.PubmedArticleSet?.PubmedArticle ?? [];
	} catch {
		return [];
	}
	const out: Paper[] = [];
	for (const record of articles) {
		const article: Json | undefined = record?.MedlineCitation?.Article;
		const title = text(article?.ArticleTitle);
		if (!article || !title) {
			continue;
		}
		const pmid = normalizePmid(text(record.MedlineCitation.PMID));
		const abstract = ((article.Abstract?.AbstractText ?? []) as unknown[])
			.map(part => {
				const body = text(part);
				const label = typeof part === 'object' && part ? cleanText((part as Json)['@_Label']) : undefined;
				return body ? (label ? `${label}: ${body}` : body) : undefined;
			})
			.filter(Boolean)
			.join('\n\n');
		const authors: string[] = [];
		for (const author of (article.AuthorList?.Author ?? []) as Json[]) {
			const collective = text(author.CollectiveName);
			const last = text(author.LastName);
			const first = text(author.ForeName) ?? text(author.Initials);
			if (collective) {
				authors.push(collective);
			} else if (last) {
				authors.push(first ? `${first} ${last}` : last);
			}
		}
		let doi: string | undefined;
		for (const eloc of (article.ELocationID ?? []) as Json[]) {
			if (eloc?.['@_EIdType'] === 'doi') {
				doi ??= normalizeDoi(text(eloc));
			}
		}
		let pmcid: string | undefined;
		for (const id of (record.PubmedData?.ArticleIdList?.ArticleId ?? []) as Json[]) {
			const type = String(id?.['@_IdType'] ?? '').toLowerCase();
			if (type === 'doi') {
				doi ??= normalizeDoi(text(id));
			} else if (type === 'pmc' || type === 'pmcid') {
				pmcid = normalizePmcid(text(id));
			}
		}
		const pubDate: Json | undefined = article.Journal?.JournalIssue?.PubDate;
		out.push({
			fingerprint: makeFingerprint({ doi, pmid, pmcid, source: 'pubmed', sourceId: pmid }),
			title,
			abstract,
			authors,
			journal: text(article.Journal?.Title) ?? text(article.Journal?.ISOAbbreviation) ?? '',
			year: safeInt(text(pubDate?.Year)) ?? safeInt(text(pubDate?.MedlineDate)),
			doi, pmid, pmcid,
			fullTextUrl: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : undefined,
			citationCount: 0,
			sources: ['pubmed']
		});
	}
	return out;
}

class PubMedEngine implements Engine {
	readonly source = 'pubmed';
	private static readonly ESEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
	private static readonly EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
	private readonly client: HttpClient;

	constructor(private readonly options: EngineOptions) {
		// NCBI: 3 requests a second without a key, 10 with one
		this.client = new HttpClient({ userAgent: options.userAgent, requestsPerSecond: options.ncbiApiKey ? 8 : 2.5 });
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]> {
		const common = { tool: 'datasuite-atelier', email: this.options.email, api_key: this.options.ncbiApiKey };
		const found = await this.client.getJson<Json>(PubMedEngine.ESEARCH, { ...common, db: 'pubmed', term: query, retmode: 'json', retmax: Math.min(limit, 200), sort: 'relevance' }, undefined, signal);
		const pmids: string[] = found?.esearchresult?.idlist ?? [];
		if (!pmids.length) {
			return [];
		}
		const xml = await this.client.getText(PubMedEngine.EFETCH, { ...common, db: 'pubmed', id: pmids.join(','), retmode: 'xml' }, undefined, signal);
		return parsePubmedXml(xml);
	}
}

// ---- Europe PMC

/** One result of Europe PMC's search (resultType core). */
export function normalizeEuropePmc(item: Json): Paper {
	const doi = normalizeDoi(item.doi);
	const pmid = normalizePmid(item.pmid ?? (item.source === 'MED' ? item.id : undefined));
	const pmcid = normalizePmcid(item.pmcid);
	let fullTextUrl: string | undefined;
	let pdfUrl: string | undefined;
	const links = item.fullTextUrlList?.fullTextUrl;
	for (const link of Array.isArray(links) ? links as Json[] : []) {
		const url = cleanText(link?.url);
		if (!url) {
			continue;
		}
		fullTextUrl ??= url;
		if (String(link.documentStyle ?? '').toLowerCase() === 'pdf') {
			pdfUrl = url;
		}
	}
	return {
		fingerprint: makeFingerprint({ doi, pmid, pmcid, source: 'europepmc', sourceId: cleanText(item.id) }),
		title: stripTags(String(item.title)).replace(/\.$/, ''),
		abstract: stripTags(cleanText(item.abstractText)),
		authors: splitAuthors(item.authorString),
		journal: cleanText(item.journalInfo?.journal?.title ?? item.journalTitle ?? item.bookOrReportDetails?.publisher) ?? '',
		year: safeInt(item.pubYear ?? item.firstPublicationDate),
		doi, pmid, pmcid, pdfUrl,
		fullTextUrl: fullTextUrl ?? (item.source && item.id ? `https://europepmc.org/article/${item.source}/${item.id}` : undefined),
		citationCount: safeInt(item.citedByCount) ?? 0,
		sources: ['europepmc']
	};
}

class EuropePmcEngine implements Engine {
	readonly source = 'europepmc';
	private readonly client: HttpClient;

	constructor(options: EngineOptions) {
		this.client = new HttpClient({ userAgent: options.userAgent, requestsPerSecond: 4 });
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]> {
		const payload = await this.client.getJson<Json>('https://www.ebi.ac.uk/europepmc/webservices/rest/search', { query, format: 'json', pageSize: Math.min(limit, 1000), resultType: 'core' }, undefined, signal);
		const items: Json[] = payload?.resultList?.result ?? [];
		return items.filter(item => cleanText(item?.title)).map(normalizeEuropePmc);
	}
}

// ---- OpenAlex

/** OpenAlex keeps an abstract as the positions of each of its words; this is the abstract again. */
export function abstractFromInvertedIndex(index: unknown): string {
	if (!index || typeof index !== 'object') {
		return '';
	}
	const words: string[] = [];
	for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
		for (const position of Array.isArray(positions) ? positions : []) {
			if (typeof position === 'number' && position >= 0 && position < 20000) {
				words[position] = word;
			}
		}
	}
	return words.filter(Boolean).join(' ');
}

/** One work of OpenAlex's. */
export function normalizeOpenAlex(item: Json): Paper {
	const ids: Json = item.ids ?? {};
	const doi = normalizeDoi(ids.doi ?? item.doi);
	const pmid = normalizePmid(ids.pmid);
	const pmcid = normalizePmcid(ids.pmcid);
	const landing = cleanText(item.best_oa_location?.landing_page_url ?? item.primary_location?.landing_page_url ?? item.open_access?.oa_url);
	return {
		fingerprint: makeFingerprint({ doi, pmid, pmcid, source: 'openalex', sourceId: cleanText(item.id) }),
		title: stripTags(cleanText(item.display_name ?? item.title)),
		abstract: abstractFromInvertedIndex(item.abstract_inverted_index),
		authors: ((item.authorships ?? []) as Json[]).map(a => cleanText(a?.author?.display_name)).filter((name): name is string => !!name),
		journal: cleanText(item.primary_location?.source?.display_name) ?? '',
		year: safeInt(item.publication_year),
		doi, pmid, pmcid,
		pdfUrl: cleanText(item.best_oa_location?.pdf_url ?? item.primary_location?.pdf_url),
		fullTextUrl: landing ?? (doi ? `https://doi.org/${doi}` : undefined),
		citationCount: safeInt(item.cited_by_count) ?? 0,
		sources: ['openalex']
	};
}

class OpenAlexEngine implements Engine {
	readonly source = 'openalex';
	private readonly client: HttpClient;

	constructor(private readonly options: EngineOptions) {
		this.client = new HttpClient({ userAgent: options.userAgent, requestsPerSecond: 4 });
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]> {
		const payload = await this.client.getJson<Json>('https://api.openalex.org/works', { search: query, per_page: Math.min(limit, 100), mailto: this.options.email, api_key: this.options.openAlexApiKey }, undefined, signal);
		const items: Json[] = payload?.results ?? [];
		return items.filter(item => cleanText(item?.display_name ?? item?.title)).map(normalizeOpenAlex);
	}
}

// ---- Semantic Scholar

/** One paper of Semantic Scholar's. */
export function normalizeSemanticScholar(item: Json): Paper {
	const ext: Json = item.externalIds ?? {};
	const doi = normalizeDoi(ext.DOI);
	const pmid = normalizePmid(ext.PubMed ?? ext.PMID);
	const pmcid = normalizePmcid(ext.PubMedCentral ?? ext.PMCID);
	const pdfUrl = cleanText(item.openAccessPdf?.url);
	return {
		fingerprint: makeFingerprint({ doi, pmid, pmcid, arxivId: cleanText(ext.ArXiv), source: 'semanticscholar', sourceId: cleanText(item.paperId) }),
		title: stripTags(cleanText(item.title)),
		abstract: stripTags(cleanText(item.abstract)),
		authors: ((item.authors ?? []) as Json[]).map(a => cleanText(a?.name)).filter((name): name is string => !!name),
		journal: cleanText(item.venue) ?? '',
		year: safeInt(item.year ?? item.publicationDate),
		doi, pmid, pmcid, pdfUrl,
		fullTextUrl: pdfUrl ?? cleanText(item.url),
		citationCount: safeInt(item.citationCount) ?? 0,
		sources: ['semanticscholar']
	};
}

class SemanticScholarEngine implements Engine {
	readonly source = 'semanticscholar';
	private readonly client: HttpClient;

	constructor(private readonly options: EngineOptions) {
		// without a key Semantic Scholar shares one small allowance among everyone: ask slowly
		this.client = new HttpClient({ userAgent: options.userAgent, requestsPerSecond: options.semanticScholarApiKey ? 1 : 0.5 });
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]> {
		const fields = 'title,abstract,year,venue,url,authors,externalIds,openAccessPdf,citationCount,publicationDate';
		const headers = this.options.semanticScholarApiKey ? { 'x-api-key': this.options.semanticScholarApiKey } : undefined;
		const payload = await this.client.getJson<Json>('https://api.semanticscholar.org/graph/v1/paper/search', { query, limit: Math.min(limit, 100), fields }, headers, signal);
		const items: Json[] = payload?.data ?? [];
		return items.filter(item => cleanText(item?.title)).map(normalizeSemanticScholar);
	}
}

// ---- Crossref: every discipline, by DOI registration

/** One work of Crossref's. */
export function normalizeCrossref(item: Json): Paper {
	const doi = normalizeDoi(item.DOI);
	const first = (value: unknown) => cleanText(Array.isArray(value) ? value[0] : value);
	return {
		fingerprint: makeFingerprint({ doi, source: 'crossref', sourceId: doi }),
		title: stripTags(first(item.title)),
		abstract: stripTags(cleanText(item.abstract)),
		authors: ((item.author ?? []) as Json[]).map(a => cleanText([a?.given, a?.family].filter(Boolean).join(' ')) ?? cleanText(a?.name)).filter((name): name is string => !!name),
		journal: first(item['container-title']) ?? cleanText(item.publisher) ?? '',
		year: safeInt(item.issued?.['date-parts']?.[0]?.[0]),
		doi,
		fullTextUrl: doi ? `https://doi.org/${doi}` : cleanText(item.URL),
		citationCount: safeInt(item['is-referenced-by-count']) ?? 0,
		sources: ['crossref']
	};
}

class CrossrefEngine implements Engine {
	readonly source = 'crossref';
	private readonly client: HttpClient;

	constructor(private readonly options: EngineOptions) {
		this.client = new HttpClient({ userAgent: options.userAgent, requestsPerSecond: 3 });
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]> {
		const payload = await this.client.getJson<Json>('https://api.crossref.org/works', {
			query, rows: Math.min(limit, 100), mailto: this.options.email,
			select: 'DOI,title,author,container-title,publisher,issued,abstract,is-referenced-by-count,URL,type'
		}, undefined, signal);
		const items: Json[] = payload?.message?.items ?? [];
		// what a review reads: articles, chapters, reports, preprints -- not a journal's issue or a dataset's record
		return items.filter(item => cleanText(Array.isArray(item?.title) ? item.title[0] : item?.title) && !/^(journal|journal-issue|journal-volume|component|dataset|peer-review|grant)$/.test(String(item.type ?? ''))).map(normalizeCrossref);
	}
}

// ---- CORE: open-access repositories -- theses, reports and working papers beside articles

/** One work of CORE's. */
export function normalizeCore(item: Json): Paper {
	const doi = normalizeDoi(item.doi);
	const pmid = normalizePmid(item.pubmedId);
	const pdfUrl = cleanText(item.downloadUrl);
	const journal = Array.isArray(item.journals) ? cleanText(item.journals[0]?.title) : undefined;
	return {
		fingerprint: makeFingerprint({ doi, pmid, arxivId: cleanText(item.arxivId), source: 'core', sourceId: cleanText(item.id) }),
		title: stripTags(cleanText(item.title)),
		abstract: stripTags(cleanText(item.abstract)),
		// CORE writes "Family, Given"
		authors: ((item.authors ?? []) as Json[]).map(a => cleanText(a?.name)).filter((name): name is string => !!name),
		journal: journal ?? cleanText(item.publisher) ?? '',
		year: safeInt(item.yearPublished ?? item.publishedDate),
		doi, pmid, pdfUrl,
		fullTextUrl: pdfUrl ?? (doi ? `https://doi.org/${doi}` : item.id ? `https://core.ac.uk/works/${item.id}` : undefined),
		citationCount: safeInt(item.citationCount) ?? 0,
		sources: ['core']
	};
}

class CoreEngine implements Engine {
	readonly source = 'core';
	private readonly client: HttpClient;

	constructor(private readonly options: EngineOptions) {
		// without a key CORE allows few requests, slowly
		this.client = new HttpClient({ userAgent: options.userAgent, requestsPerSecond: options.coreApiKey ? 2 : 0.4, timeoutMs: 40000, retries: 1 });
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]> {
		const headers = this.options.coreApiKey ? { Authorization: `Bearer ${this.options.coreApiKey}` } : undefined;
		const payload = await this.client.getJson<Json>('https://api.core.ac.uk/v3/search/works/', { q: query, limit: Math.min(limit, 100) }, headers, signal);
		const items: Json[] = payload?.results ?? [];
		return items.filter(item => cleanText(item?.title)).map(normalizeCore);
	}
}

// ---- arXiv: preprints in physics, mathematics, computing, statistics, quantitative biology and economics

const arxivXml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, htmlEntities: true, isArray: name => ['entry', 'author', 'link'].includes(name) });

/** The entries of an arXiv API answer (Atom). */
export function parseArxivAtom(xml: string): Paper[] {
	let entries: Json[];
	try {
		entries = arxivXml.parse(xml)?.feed?.entry ?? [];
	} catch {
		return [];
	}
	const out: Paper[] = [];
	for (const entry of entries) {
		const title = text(entry?.title);
		// "http://arxiv.org/abs/2101.00001v2": the id, without its version
		const arxivId = cleanText(text(entry?.id)?.split('/abs/').pop()?.replace(/v\d+$/, ''));
		if (!title || !arxivId) {
			continue;
		}
		const doi = normalizeDoi(text(entry['arxiv:doi']));
		const pdf = ((entry.link ?? []) as Json[]).find(l => l?.['@_title'] === 'pdf' || l?.['@_type'] === 'application/pdf');
		out.push({
			fingerprint: makeFingerprint({ doi, arxivId, source: 'arxiv', sourceId: arxivId }),
			title,
			abstract: text(entry.summary) ?? '',
			authors: ((entry.author ?? []) as Json[]).map(a => text(a?.name)).filter((name): name is string => !!name),
			journal: text(entry['arxiv:journal_ref']) ?? 'arXiv',
			year: safeInt(text(entry.published)?.slice(0, 4)),
			doi,
			pdfUrl: cleanText(pdf?.['@_href']),
			fullTextUrl: `https://arxiv.org/abs/${arxivId}`,
			citationCount: 0,
			sources: ['arxiv']
		});
	}
	return out;
}

class ArxivEngine implements Engine {
	readonly source = 'arxiv';
	private readonly client: HttpClient;

	constructor(options: EngineOptions) {
		// arXiv asks for a request every three seconds at most
		this.client = new HttpClient({ userAgent: options.userAgent, requestsPerSecond: 0.33, timeoutMs: 10000, retries: 0 });
	}

	async search(query: string, limit: number, signal?: AbortSignal): Promise<Paper[]> {
		const words = query.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(word => word.length > 2).slice(0, 8);
		if (!words.length) {
			return [];
		}
		const xml = await this.client.getText('https://export.arxiv.org/api/query', { search_query: words.map(word => `all:${word}`).join(' AND '), max_results: Math.min(limit, 50), sortBy: 'relevance' }, undefined, signal);
		return parseArxivAtom(xml);
	}
}

/** The databases, in the order their papers are merged. */
export function createEngines(options: EngineOptions): Engine[] {
	return [new PubMedEngine(options), new EuropePmcEngine(options), new OpenAlexEngine(options), new SemanticScholarEngine(options), new CrossrefEngine(options), new CoreEngine(options), new ArxivEngine(options)];
}
