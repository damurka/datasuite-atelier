/*---------------------------------------------------------------------------------------------
 *  Atelier: what OpenAlex knows of the candidates, asked by DOI in a few requests -- citation counts (PubMed gives
 *  none), an open-access PDF, a missing abstract, and how cited the journal is. And the open-access full text of a
 *  paper, from Europe PMC. No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

import { Paper } from '../shared/api';
import { cleanText, normalizeDoi, safeInt, stripTags } from '../core/text';
import { abstractFromInvertedIndex, parsePubmedXml } from './engines';
import { HttpClient } from './http';

type Json = Record<string, any>;

/** DOIs or journals asked for in one request. */
const BATCH = 50;

/**
 * Fills in the papers that have a DOI from OpenAlex. Never throws for a database that doesn't answer: the papers stay
 * as they were and the reason is the result (a cancelled search does throw).
 */
export async function enrichFromOpenAlex(papers: readonly Paper[], client: HttpClient, options: { email?: string; apiKey?: string }, signal?: AbortSignal): Promise<string | undefined> {
	const byDoi = new Map<string, Paper>();
	for (const paper of papers) {
		if (paper.doi) {
			byDoi.set(paper.doi, paper);
		}
	}
	// a DOI with the filter's own separators can't be asked for in a list
	const dois = [...byDoi.keys()].filter(doi => !/[|,]/.test(doi));
	const journalOf = new Map<Paper, string>();
	const common = { mailto: options.email, api_key: options.apiKey };
	try {
		const batches: string[][] = [];
		for (let i = 0; i < dois.length; i += BATCH) {
			batches.push(dois.slice(i, i + BATCH));
		}
		await Promise.all(batches.map(async batch => {
			const payload = await client.getJson<Json>('https://api.openalex.org/works', { ...common, filter: `doi:${batch.join('|')}`, per_page: BATCH, select: 'doi,cited_by_count,best_oa_location,primary_location,abstract_inverted_index' }, undefined, signal);
			for (const work of (payload?.results ?? []) as Json[]) {
				const paper = byDoi.get(normalizeDoi(work.doi) ?? '');
				if (!paper) {
					continue;
				}
				paper.citationCount = Math.max(paper.citationCount, safeInt(work.cited_by_count) ?? 0);
				paper.pdfUrl ??= cleanText(work.best_oa_location?.pdf_url ?? work.primary_location?.pdf_url);
				paper.abstract ||= abstractFromInvertedIndex(work.abstract_inverted_index);
				paper.journal ||= cleanText(work.primary_location?.source?.display_name) ?? '';
				const journal = cleanText(work.primary_location?.source?.id)?.split('/').pop();
				if (journal) {
					journalOf.set(paper, journal);
				}
			}
		}));
		const journals = [...new Set(journalOf.values())];
		const impact = new Map<string, number>();
		for (let i = 0; i < journals.length; i += BATCH) {
			const payload = await client.getJson<Json>('https://api.openalex.org/sources', { ...common, filter: `openalex:${journals.slice(i, i + BATCH).join('|')}`, per_page: BATCH, select: 'id,summary_stats' }, undefined, signal);
			for (const source of (payload?.results ?? []) as Json[]) {
				const citedness = Number(source.summary_stats?.['2yr_mean_citedness']);
				const id = cleanText(source.id)?.split('/').pop();
				if (id && Number.isFinite(citedness)) {
					impact.set(id, Math.round(citedness * 10) / 10);
				}
			}
		}
		for (const [paper, journal] of journalOf) {
			paper.journalImpact = impact.get(journal) ?? paper.journalImpact;
		}
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		return error instanceof Error ? error.message : String(error);
	}
	return undefined;
}

/**
 * Abstracts for the papers that came without one (OpenAlex and Semantic Scholar often have none): from PubMed by PMID,
 * then from Europe PMC by DOI. Never throws for a database that doesn't answer (a cancelled search does throw).
 */
export async function fillAbstracts(papers: readonly Paper[], clients: { pubmed: HttpClient; europePmc: HttpClient }, options: { email?: string; ncbiApiKey?: string }, signal?: AbortSignal): Promise<void> {
	const attempt = async (work: () => Promise<void>) => {
		try {
			await work();
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
		}
	};
	const byPmid = new Map(papers.filter(paper => !paper.abstract && paper.pmid).map(paper => [paper.pmid!, paper]));
	for (let ids = [...byPmid.keys()]; ids.length; ids = ids.slice(100)) {
		await attempt(async () => {
			const xml = await clients.pubmed.getText('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi', { tool: 'datasuite-atelier', email: options.email, api_key: options.ncbiApiKey, db: 'pubmed', id: ids.slice(0, 100).join(','), retmode: 'xml' }, undefined, signal);
			for (const found of parsePubmedXml(xml)) {
				const paper = found.pmid ? byPmid.get(found.pmid) : undefined;
				if (paper && found.abstract) {
					paper.abstract = found.abstract;
				}
			}
		});
	}
	const byDoi = new Map(papers.filter(paper => !paper.abstract && paper.doi && !paper.doi.includes('"')).map(paper => [paper.doi!, paper]));
	const dois = [...byDoi.keys()];
	const batches: string[][] = [];
	for (let i = 0; i < dois.length; i += 20) {
		batches.push(dois.slice(i, i + 20));
	}
	await Promise.all(batches.map(batch => attempt(async () => {
		const payload = await clients.europePmc.getJson<Json>('https://www.ebi.ac.uk/europepmc/webservices/rest/search', { query: batch.map(doi => `DOI:"${doi}"`).join(' OR '), format: 'json', pageSize: 100, resultType: 'core' }, undefined, signal);
		for (const item of (payload?.resultList?.result ?? []) as Json[]) {
			const paper = byDoi.get(normalizeDoi(item.doi) ?? '');
			const abstract = stripTags(cleanText(item.abstractText));
			if (paper && abstract && !paper.abstract) {
				paper.abstract = abstract;
				paper.pmcid ??= cleanText(item.pmcid)?.toUpperCase();
				paper.pmid ??= cleanText(item.pmid);
			}
		}
	})));
}

/**
 * The PMCID of the papers that have a DOI or PMID but none: with it, a paper's open-access full text can be fetched.
 * Never throws for a database that doesn't answer (a cancelled search does throw).
 */
export async function findPmcids(papers: readonly Paper[], client: HttpClient, signal?: AbortSignal): Promise<void> {
	const wanted = papers.filter(paper => !paper.pmcid && (paper.pmid || (paper.doi && !paper.doi.includes('"'))));
	const batches: Paper[][] = [];
	for (let i = 0; i < wanted.length; i += 20) {
		batches.push(wanted.slice(i, i + 20));
	}
	await Promise.all(batches.map(async batch => {
		try {
			const query = batch.map(paper => paper.pmid ? `(EXT_ID:${paper.pmid} AND SRC:MED)` : `DOI:"${paper.doi}"`).join(' OR ');
			const payload = await client.getJson<Json>('https://www.ebi.ac.uk/europepmc/webservices/rest/search', { query, format: 'json', pageSize: 100, resultType: 'lite' }, undefined, signal);
			for (const item of (payload?.resultList?.result ?? []) as Json[]) {
				const pmcid = cleanText(item.pmcid)?.toUpperCase();
				const doi = normalizeDoi(item.doi);
				const pmid = cleanText(item.pmid);
				const paper = pmcid ? batch.find(p => (pmid && p.pmid === pmid) || (doi && p.doi === doi)) : undefined;
				if (paper) {
					paper.pmcid = pmcid;
				}
			}
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
		}
	}));
}

/**
 * The parts of a full text (as {@link fullTextFromXml} writes it: sections under headings in capitals) that say who was
 * studied and how, within `budget` characters: the methods first, then the results, then the discussion, and the
 * rest (the introduction) with what room is left -- in the paper's own order.
 */
export function focusFullText(text: string, budget: number): string {
	if (text.length <= budget) {
		return text;
	}
	const sections = text.split(/\n\n(?=[^a-z\n]{3,}\n)/);
	const rank = (section: string) => {
		const heading = section.slice(0, section.indexOf('\n') >>> 0).toUpperCase();
		return /METHOD|PARTICIPANT|DESIGN|SETTING|SAMPL|POPULATION|PROCEDURE|MATERIAL|DATA |ANALYS|ELIGIB|RECRUIT/.test(heading) ? 0
			: /RESULT|FINDING|OUTCOME|CHARACTERISTIC/.test(heading) ? 1
				: /DISCUSSION|CONCLUSION|LIMITATION/.test(heading) ? 2 : 3;
	};
	const kept = new Array<string>(sections.length).fill('');
	let left = budget;
	for (const index of sections.map((_section, i) => i).sort((a, b) => rank(sections[a]) - rank(sections[b]) || a - b)) {
		if (left < 200) {
			break;
		}
		kept[index] = sections[index].length <= left ? sections[index] : `${sections[index].slice(0, left - 3).trimEnd()}...`;
		left -= kept[index].length + 2;
	}
	return kept.filter(Boolean).join('\n\n');
}

/** The prose of a JATS article (Europe PMC's fullTextXML): its body's headings and paragraphs, without tables, figures and references. */
export function fullTextFromXml(xml: string): string {
	const body = /<body[\s>][\s\S]*<\/body>/i.exec(xml)?.[0];
	if (!body) {
		return '';
	}
	const prose = body.replace(/<(table-wrap|fig|ref-list|supplementary-material|disp-formula)[\s>][\s\S]*?<\/\1>/gi, ' ');
	const parts: string[] = [];
	for (const match of prose.matchAll(/<(title|p)[\s>][\s\S]*?<\/\1>/gi)) {
		const text = stripTags(match[0].replace(/<xref[\s>][\s\S]*?<\/xref>/gi, ''));
		if (text) {
			parts.push(match[1].toLowerCase() === 'title' ? `\n${text.toUpperCase()}` : text);
		}
	}
	return parts.join('\n').trim();
}

/** A paper's full text from Europe PMC, when it is in the open-access subset; else ''. */
export async function fetchFullText(client: HttpClient, pmcid: string, signal?: AbortSignal): Promise<string> {
	try {
		return fullTextFromXml(await client.getText(`https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(pmcid)}/fullTextXML`, undefined, undefined, signal));
	} catch (error) {
		if (signal?.aborted) {
			throw error;
		}
		return '';
	}
}
