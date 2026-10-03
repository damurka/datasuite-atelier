/*---------------------------------------------------------------------------------------------
 *  Atelier: one search across the databases -- each asked its own query at the same time, and what they return
 *  merged into one list of unique Papers. No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

import { Paper, Source, SourceResult } from '../shared/api';
import { makeFingerprint, titleKey } from '../core/text';
import { Engine } from './engines';

/** The queries for each database, as the AI planned them. */
export type SearchPlan = Partial<Record<Source, string[]>>;

/** `from`'s details added to `into`: the same paper, as another database has it. */
export function mergePaper(into: Paper, from: Paper): void {
	for (const source of from.sources) {
		if (!into.sources.includes(source)) {
			into.sources.push(source);
		}
	}
	into.doi ??= from.doi;
	into.pmid ??= from.pmid;
	into.pmcid ??= from.pmcid;
	into.pdfUrl ??= from.pdfUrl;
	into.fullTextUrl ??= from.fullTextUrl;
	into.year ??= from.year;
	into.journal ||= from.journal;
	if (from.abstract.length > into.abstract.length) {
		into.abstract = from.abstract;
	}
	if (!into.authors.length) {
		into.authors = from.authors;
	}
	into.citationCount = Math.max(into.citationCount, from.citationCount);
}

/**
 * Unique Papers: two records are the same paper when they share a DOI, PMID or PMCID, or (with no identifier in
 * common) a title and year. A Paper's Fingerprint is made from everything known of it once merged.
 */
export class PaperSet {

	readonly papers: Paper[] = [];
	private readonly byKey = new Map<string, Paper>();

	private keys(paper: Paper): string[] {
		const keys = [`fp:${paper.fingerprint}`];
		if (paper.doi) { keys.push(`doi:${paper.doi}`); }
		if (paper.pmid) { keys.push(`pmid:${paper.pmid}`); }
		if (paper.pmcid) { keys.push(`pmcid:${paper.pmcid}`); }
		const title = titleKey(paper.title);
		if (title.length >= 25) { keys.push(`title:${title}:${paper.year ?? ''}`); }
		return keys;
	}

	/** The papers of `papers` not known yet, added; the others are merged into the ones they are. */
	addAll(papers: readonly Paper[]): Paper[] {
		return papers.filter(paper => this.add(paper));
	}

	/** Adds the paper, or merges it into the one it is. Answers whether it was new. */
	add(paper: Paper): boolean {
		const existing = this.keys(paper).map(key => this.byKey.get(key)).find(Boolean);
		const kept = existing ?? paper;
		if (existing) {
			mergePaper(existing, paper);
		} else {
			this.papers.push(paper);
		}
		for (const key of this.keys(kept)) {
			if (!this.byKey.has(key)) {
				this.byKey.set(key, kept);
			}
		}
		return !existing;
	}

	/** The papers, each under the Fingerprint of its strongest identifier (a stored paper keeps the one it is stored under). */
	finish(): Paper[] {
		for (const paper of this.papers) {
			if (paper.sources.includes('atelier')) {
				continue;
			}
			const [source, ...id] = paper.fingerprint.split(':');
			paper.fingerprint = makeFingerprint({ doi: paper.doi, pmid: paper.pmid, pmcid: paper.pmcid, arxivId: source === 'arxiv' ? id.join(':') : undefined, source, sourceId: id.join(':') });
		}
		return this.papers;
	}
}

/**
 * Asks every database its queries in the plan -- the databases all at once, a database's own queries one after
 * another. What they return is given as it came (the databases in their order, not merged): a database's papers are
 * shared out among its queries, half as many again in all as one query would bring. A database that fails is
 * reported and the others' papers still count.
 */
export async function searchAll(
	engines: readonly Engine[],
	plan: SearchPlan,
	limit: number,
	signal: AbortSignal | undefined,
	report: (results: SourceResult[]) => void
): Promise<Paper[]> {
	const queriesOf = (engine: Engine) => [...new Set((plan[engine.source] ?? []).map(query => query.trim()).filter(query => query && query.toLowerCase() !== 'null'))];
	const asked = engines.filter(engine => queriesOf(engine).length);
	const results = new Map<Source, SourceResult>(asked.map(engine => [engine.source, { source: engine.source }]));
	const tell = () => report([...results.values()]);
	tell();
	const found = await Promise.all(asked.map(async engine => {
		const queries = queriesOf(engine);
		const each = Math.max(5, Math.ceil(limit * (queries.length > 1 ? 1.5 : 1) / queries.length));
		const papers: Paper[] = [];
		let failure: string | undefined;
		for (const query of queries) {
			try {
				papers.push(...await engine.search(query, each, signal));
			} catch (error) {
				if (signal?.aborted) {
					throw error;
				}
				failure = error instanceof Error ? error.message : String(error);
			}
		}
		// a database that answered one of its queries has answered
		results.set(engine.source, papers.length || !failure ? { source: engine.source, count: papers.length } : { source: engine.source, error: failure });
		tell();
		return papers;
	}));
	return found.flat();
}

/**
 * One search across the databases, merged into unique Papers. `known` (papers recalled from this machine's store) go
 * in first.
 */
export async function comprehensiveSearch(
	engines: readonly Engine[],
	plan: SearchPlan,
	limit: number,
	known: readonly Paper[],
	signal: AbortSignal | undefined,
	report: (results: SourceResult[]) => void
): Promise<Paper[]> {
	const set = new PaperSet();
	for (const paper of [...known, ...await searchAll(engines, plan, limit, signal, report)]) {
		set.add(paper);
	}
	return set.finish();
}
