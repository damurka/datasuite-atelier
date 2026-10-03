/*---------------------------------------------------------------------------------------------
 *  Atelier: papers found from papers, not from words -- what a keyword search misses. From the best papers a search
 *  has found so far (its seeds): the papers they cite and the papers that cite them (OpenAlex), and the papers
 *  Semantic Scholar finds similar to them. No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

import { Paper } from '../shared/api';
import { cleanText } from '../core/text';
import { normalizeOpenAlex, normalizeSemanticScholar } from './engines';
import { HttpClient } from './http';

type Json = Record<string, any>;

const WORK_FIELDS = 'id,doi,ids,display_name,title,publication_year,cited_by_count,authorships,primary_location,best_oa_location,open_access,abstract_inverted_index';
const id = (url: unknown) => cleanText(url)?.split('/').pop();

export interface ChaseOptions {
	readonly email?: string;
	readonly openAlexApiKey?: string;
	readonly semanticScholarApiKey?: string;
	/** The most papers to bring back of those the seeds cite, of those citing them, and of those like them. */
	readonly references?: number;
	readonly citing?: number;
	readonly similar?: number;
}

/**
 * The papers on the seeds' citation trail, each marked as found there (source `citations`) or as similar (source
 * `semanticscholar`). A database that doesn't answer is reported in `failed` and the rest still counts; a cancelled
 * search throws.
 */
export async function chaseCitations(seeds: readonly Paper[], clients: { openAlex: HttpClient; semanticScholar: HttpClient }, options: ChaseOptions, signal?: AbortSignal): Promise<{ papers: Paper[]; failed: string[] }> {
	const failed: string[] = [];
	const attempt = async <T>(what: string, work: () => Promise<T>, otherwise: T): Promise<T> => {
		try {
			return await work();
		} catch (error) {
			if (signal?.aborted) {
				throw error;
			}
			failed.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
			return otherwise;
		}
	};
	const dois = seeds.map(seed => seed.doi).filter((doi): doi is string => !!doi && !/[|,]/.test(doi));
	if (!dois.length) {
		return { papers: [], failed };
	}
	const common = { mailto: options.email, api_key: options.openAlexApiKey };
	const trail = (papers: Json[]) => papers.filter(item => cleanText(item?.display_name ?? item?.title)).map(item => ({ ...normalizeOpenAlex(item), sources: ['citations' as const] }));

	const openAlex = attempt('OpenAlex citations', async () => {
		// the seeds, as OpenAlex knows them: their ids and what they cite
		const found = await clients.openAlex.getJson<Json>('https://api.openalex.org/works', { ...common, filter: `doi:${dois.join('|')}`, per_page: 50, select: 'id,referenced_works' }, undefined, signal);
		const works = (found?.results ?? []) as Json[];
		const seedIds = works.map(work => id(work.id)).filter((x): x is string => !!x);
		// what the seeds cite, the papers several of them cite first
		const cited = new Map<string, number>();
		for (const work of works) {
			for (const reference of (work.referenced_works ?? []) as unknown[]) {
				const ref = id(reference);
				if (ref && !seedIds.includes(ref)) {
					cited.set(ref, (cited.get(ref) ?? 0) + 1);
				}
			}
		}
		const references = [...cited.entries()].sort((a, b) => b[1] - a[1]).slice(0, options.references ?? 60).map(([ref]) => ref);
		const batches: string[][] = [];
		for (let i = 0; i < references.length; i += 50) {
			batches.push(references.slice(i, i + 50));
		}
		const [referenced, citing] = await Promise.all([
			Promise.all(batches.map(batch => clients.openAlex.getJson<Json>('https://api.openalex.org/works', { ...common, filter: `openalex:${batch.join('|')}`, per_page: 50, select: WORK_FIELDS }, undefined, signal))),
			// what cites the seeds, the most cited first
			seedIds.length ? clients.openAlex.getJson<Json>('https://api.openalex.org/works', { ...common, filter: `cites:${seedIds.join('|')}`, per_page: Math.min(options.citing ?? 40, 100), sort: 'cited_by_count:desc', select: WORK_FIELDS }, undefined, signal) : undefined
		]);
		return trail([...referenced.flatMap(page => (page?.results ?? []) as Json[]), ...((citing?.results ?? []) as Json[])]);
	}, [] as Paper[]);

	const similar = attempt('Semantic Scholar recommendations', async () => {
		const fields = 'title,abstract,year,venue,url,authors,externalIds,openAccessPdf,citationCount,publicationDate';
		const payload = await clients.semanticScholar.postJson<Json>(
			`https://api.semanticscholar.org/recommendations/v1/papers?fields=${fields}&limit=${Math.min(options.similar ?? 30, 100)}`,
			{ positivePaperIds: dois.slice(0, 10).map(doi => `DOI:${doi}`) },
			options.semanticScholarApiKey ? { 'x-api-key': options.semanticScholarApiKey } : undefined, signal);
		return ((payload?.recommendedPapers ?? []) as Json[]).filter(item => cleanText(item?.title)).map(normalizeSemanticScholar);
	}, [] as Paper[]);

	return { papers: [...await openAlex, ...await similar], failed };
}
