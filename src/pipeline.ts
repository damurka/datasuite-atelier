/*---------------------------------------------------------------------------------------------
 *  Atelier: the work of one Query, from the prompt to its Synthesis.
 *
 *  A first prompt, or a follow-up the papers at hand can't answer, is a search: the AI plans each database's query,
 *  the databases are asked together, the candidates are ranked (closeness to the topic by DataSuite's embeddings, plus
 *  citations, recency and evidence tier), the AI reads the best of them -- screening each for relevance and
 *  extracting its details -- and writes the Synthesis from those that passed. Any other follow-up is answered from
 *  the papers of the Session's last search.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { AiEngine, ChatTurn } from './ai/engine';
import { embed } from './ai/embeddings';
import { classifyStudyType, computeMeter, cosine, embeddingText, evidenceQuality, evidenceScore, heuristicScore, hybridCloseness, Judgment, keywordScores, OFF_TOPIC, rankScores, SCREENED_RELEVANT, spread } from './core/scoring';
import { normalizeDoi, tidyCitations } from './core/text';
import { chaseCitations } from './search/chase';
import { createEngines } from './search/engines';
import { enrichFromOpenAlex, fetchFullText, fillAbstracts, findPmcids } from './search/enrich';
import { HttpClient } from './search/http';
import { PaperSet, searchAll } from './search/search';
import { CitedPaper, Extraction, FoundPaper, Paper, Ranking, Run } from './shared/api';
import { AtelierStore, QueryPaper, StoredQuery } from './store';

/** Papers of this machine's store recalled for a topic: at most this many, at least this close. */
const RECALL_LIMIT = 25;
const RECALL_SIMILARITY = 0.6;
/** The candidates that get the first screening, the closest to the topic first (all of them, short of a very large pool). */
const SCREEN_LIMIT = 500;
/** Requests to the AI at once while the papers are read, and the abstracts read in one request. */
const READ_CONCURRENCY = 6;
const READ_BATCH = 5;
/** The citation trail is followed from the best papers found: this many at most, each screened at least this high. */
const SEEDS = 8;
const SEED_RATING = 60;
/** The databases asked unless the setting says otherwise (arXiv is for physics, computing and mathematics). */
const DEFAULT_DATABASES = ['pubmed', 'europepmc', 'openalex', 'semanticscholar', 'crossref', 'core'];

const SECRETS = { ncbi: 'atelier.ncbiApiKey', openAlex: 'atelier.openAlexApiKey', semanticScholar: 'atelier.semanticScholarApiKey', core: 'atelier.coreApiKey' } as const;
export const API_KEY_SECRETS = SECRETS;

export class Pipeline implements vscode.Disposable {

	private readonly runs = new Map<string, { run: Run; cancel: vscode.CancellationTokenSource }>();
	private readonly _onDidChangeRun = new vscode.EventEmitter<Run>();
	readonly onDidChangeRun = this._onDidChangeRun.event;

	/** Full texts fetched this session, by PMCID ('' when the paper isn't open access): a summary doesn't fetch what the search did. */
	private readonly fullTexts = new Map<string, Promise<string>>();
	private readonly summaries = new Map<string, Promise<string>>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly store: AtelierStore,
		private readonly log: vscode.LogOutputChannel
	) { }

	private get userAgent(): string {
		return `DataSuite-Atelier/${this.context.extension.packageJSON.version}`;
	}

	/** The paper's open-access full text (Europe PMC), or '' when it has none or full text isn't to be read. */
	private fullText(paper: Paper, signal?: AbortSignal): Promise<string> {
		if (!paper.pmcid || vscode.workspace.getConfiguration('atelier').get<boolean>('readFullText') === false) {
			return Promise.resolve('');
		}
		let text = this.fullTexts.get(paper.pmcid);
		if (!text) {
			this.europePmc ??= new HttpClient({ userAgent: this.userAgent, requestsPerSecond: 6, retries: 1 });
			text = fetchFullText(this.europePmc, paper.pmcid, signal);
			this.fullTexts.set(paper.pmcid, text);
			text.catch(() => this.fullTexts.delete(paper.pmcid!));
		}
		return text;
	}
	private europePmc: HttpClient | undefined;

	/** A Paper Summary for the Session's topic: made once, then kept with the Session. */
	async summarizePaper(sessionId: string, fingerprint: string, modelId: string): Promise<string> {
		const kept = this.store.paperSummary(sessionId, fingerprint);
		if (kept) {
			return kept;
		}
		const key = `${sessionId}\n${fingerprint}`;
		let pending = this.summaries.get(key);
		if (!pending) {
			pending = (async () => {
				const paper = this.store.paper(fingerprint);
				const topic = this.store.topicOf(sessionId);
				if (!paper || !topic) {
					throw new Error('That paper is no longer in the session.');
				}
				const [model] = await vscode.lm.selectChatModels({ id: modelId });
				if (!model) {
					throw new Error('That AI model is no longer available. Choose another.');
				}
				const cancel = new vscode.CancellationTokenSource();
				try {
					const summary = await new AiEngine(model, this.log).summarize(topic, paper, await this.fullText(paper), cancel.token);
					this.store.savePaperSummary(sessionId, fingerprint, summary);
					return summary;
				} catch (error) {
					throw new Error(describe(error));
				} finally {
					cancel.dispose();
				}
			})().finally(() => this.summaries.delete(key));
			this.summaries.set(key, pending);
		}
		return pending;
	}

	dispose(): void {
		for (const { cancel } of this.runs.values()) {
			cancel.cancel();
		}
		this._onDidChangeRun.dispose();
	}

	listRuns(): Run[] {
		return [...this.runs.values()].map(entry => entry.run);
	}

	stopAll(): void {
		for (const { cancel } of this.runs.values()) {
			cancel.cancel();
		}
	}

	stop(sessionId: string): void {
		this.runs.get(sessionId)?.cancel.cancel();
	}

	/** Starts the Query and resolves with its Session's id; the work goes on, told through `onDidChangeRun`. */
	async ask(sessionId: string | undefined, prompt: string, modelId: string, selected: readonly string[] = []): Promise<string> {
		prompt = prompt.trim();
		if (!prompt) {
			throw new Error('Ask a question first.');
		}
		if (sessionId && this.runs.has(sessionId)) {
			throw new Error('This session is still working on the last question.');
		}
		const [model] = await vscode.lm.selectChatModels({ id: modelId });
		if (!model) {
			throw new Error('That AI model is no longer available. Choose another.');
		}
		if (!sessionId || !this.store.hasSession(sessionId)) {
			sessionId = randomUUID().slice(0, 8);
			this.store.createSession(sessionId, prompt);
		}
		const id = sessionId;
		const cancel = new vscode.CancellationTokenSource();
		const entry = { run: { sessionId: id, prompt, model: model.name, phase: 'routing' } as Run, cancel };
		this.runs.set(id, entry);
		const update = (change: Partial<Run>) => {
			entry.run = { ...entry.run, ...change };
			this._onDidChangeRun.fire(entry.run);
		};
		update({});
		void this.work(id, prompt, model, selected, cancel.token, update).then(
			(): Partial<Run> => ({ phase: 'done' }),
			(error): Partial<Run> => {
				if (cancel.token.isCancellationRequested || error instanceof vscode.CancellationError) {
					return { phase: 'stopped' };
				}
				this.log.error(`"${prompt}" failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
				return { phase: 'failed', error: describe(error) };
			}
		).then(ended => {
			// the Session is free for its next question before anyone is told this one has ended
			this.runs.delete(id);
			cancel.dispose();
			this.store.dropIfEmpty(id);
			update(ended);
		});
		return id;
	}

	private async work(sessionId: string, prompt: string, model: vscode.LanguageModelChat, selected: readonly string[], token: vscode.CancellationToken, update: (change: Partial<Run>) => void): Promise<void> {
		const ai = new AiEngine(model, this.log);
		const session = this.store.getSession(sessionId);
		const lastSearch = session?.queries.findLast(query => query.route === 'search' && query.papers.length > 0);
		const base = { id: randomUUID().slice(0, 8), prompt, model: model.name, createdAt: Date.now() };

		// what the stream writes is shown a few times a second, not on every token
		let shown = 0;
		const onText = (text: string) => {
			if (Date.now() - shown > 120) {
				shown = Date.now();
				update({ text });
			}
		};

		if (lastSearch) {
			const about = lastSearch.papers.filter(paper => selected.includes(paper.fingerprint));
			const topic = lastSearch.searchQuery ?? lastSearch.prompt;
			// papers picked out are what the follow-up is about; otherwise the AI says whether the ones at hand can answer it
			const routed = about.length ? { route: 'chat' as const, searchQuery: prompt } : await ai.route(prompt, topic, lastSearch.papers, token);
			if (routed.route === 'chat') {
				const papers = about.length ? about : lastSearch.papers;
				update({ phase: 'answering', route: 'chat' });
				const history: ChatTurn[] = (session?.queries ?? []).flatMap(query => [
					{ role: 'user' as const, content: query.prompt },
					{ role: 'assistant' as const, content: query.synthesis }
				]).slice(-6);
				const answer = await ai.chat([...history, { role: 'user', content: prompt }], papers, token, onText);
				this.store.addQuery(sessionId, { ...base, route: 'chat', synthesis: tidyCitations(answer), papers: papers.map(toQueryPaper) });
				return;
			}
			await this.search(sessionId, base, routed.searchQuery, ai, token, update, onText);
			return;
		}
		await this.search(sessionId, base, prompt, ai, token, update, onText);
	}

	/** The model that screens and reads the papers: the one set for that work, while DataSuite offers it; else the question's own. */
	private async workerFor(ai: AiEngine): Promise<AiEngine> {
		const id = vscode.workspace.getConfiguration('atelier').get<string>('workModel')?.trim();
		if (id) {
			const [model] = await vscode.lm.selectChatModels({ id }).then(models => models, () => []);
			if (model) {
				return new AiEngine(model, this.log);
			}
			this.log.warn(`The model set for screening and reading (${id}) is not offered now; the question's model does that work`);
		}
		return ai;
	}

	/**
	 * The candidates for a topic, ranked: the databases' answers to the planned queries, widened by the citation trail
	 * of the best of them and, when few answer the question, by a second search in the words of those that do. Every
	 * candidate is completed (citations, journal, abstract), embedded and screened against the question.
	 */
	private async gather(
		topic: string,
		judged: { liked: readonly Paper[]; disliked: ReadonlySet<string> },
		ai: AiEngine,
		worker: AiEngine,
		token: vscode.CancellationToken,
		signal: AbortSignal,
		update: (change: Partial<Run>) => void
	): Promise<{ ranked: CitedPaper[]; ranking: Ranking; yesNo: boolean; candidates: number } | undefined> {
		const config = vscode.workspace.getConfiguration('atelier');
		const wanted = Math.max(1, config.get<number>('referencesWanted') ?? 20);
		const limit = config.get<number>('maxResultsPerSource') ?? 50;

		// 1. the AI plans each database's queries, while the topic is embedded
		update({ phase: 'planning', route: 'search' });
		const [{ plan, yesNo }, topicVector] = await Promise.all([ai.planQueries(topic, token), embed([topic], 'query', token)]);
		this.log.info(`"${topic}" (${yesNo ? 'a yes/no question' : 'an open question'}): ${JSON.stringify(plan)}`);
		const meaning = topicVector.ok && topicVector.vectors.length ? { vector: topicVector.vectors[0], model: topicVector.model } : undefined;

		// 2. the databases, and the papers already known that are close to the topic or were judged to answer it
		update({ phase: 'searching' });
		const email = config.get<string>('contactEmail')?.trim() || undefined;
		const secret = (name: keyof typeof SECRETS) => this.context.secrets.get(SECRETS[name]);
		const [ncbiApiKey, openAlexApiKey, semanticScholarApiKey, coreApiKey] = await Promise.all([secret('ncbi'), secret('openAlex'), secret('semanticScholar'), secret('core')]);
		const enabled = new Set(config.get<string[]>('databases') ?? DEFAULT_DATABASES);
		const engines = createEngines({ userAgent: this.userAgent, email, ncbiApiKey, openAlexApiKey, semanticScholarApiKey, coreApiKey }).filter(engine => enabled.has(engine.source));
		const http = (requestsPerSecond: number) => new HttpClient({ userAgent: this.userAgent, requestsPerSecond, retries: 1 });
		const pool = new PaperSet();
		pool.addAll(judged.liked.map(paper => ({ ...paper, authors: [...paper.authors], sources: ['atelier' as const] })));
		pool.addAll(meaning ? this.store.recall(meaning.vector, meaning.model, RECALL_LIMIT, RECALL_SIMILARITY) : []);
		pool.addAll(await searchAll(engines, plan, limit, signal, sources => update({ sources })));
		update({ candidates: pool.papers.length });
		if (!pool.papers.length) {
			return undefined;
		}

		// What is known of each candidate, by the paper itself (a paper's Fingerprint may strengthen as it is merged)
		const similarity = new Map<Paper, number>();
		const rating = new Map<Paper, number>();
		let embedded = !!meaning;
		const examples = { relevant: judged.liked.map(paper => paper.title), irrelevant: pool.papers.filter(paper => judged.disliked.has(paper.fingerprint)).map(paper => paper.title) };

		/** Completes new candidates -- citations, journal, a missing abstract -- then embeds and screens them. */
		const assess = async (fresh: readonly Paper[], first = false) => {
			const unenriched = await enrichFromOpenAlex(fresh, http(6), { email, apiKey: openAlexApiKey }, signal);
			if (unenriched) {
				this.log.warn(`Citations and journals not added from OpenAlex: ${unenriched}`);
			}
			await fillAbstracts(fresh, { pubmed: http(ncbiApiKey ? 8 : 2.5), europePmc: http(6) }, { email, ncbiApiKey }, signal);
			pool.finish();
			if (meaning && embedded) {
				const vectors = fresh.map(paper => this.store.vector(paper.fingerprint, meaning.model));
				const missing = fresh.map((_paper, i) => i).filter(i => !vectors[i]);
				const made = await embed(missing.map(i => embeddingText(fresh[i])), 'document', token);
				if (made.ok) {
					const kept = new Map<string, Float32Array>();
					missing.forEach((index, i) => {
						vectors[index] = made.vectors[i];
						kept.set(fresh[index].fingerprint, made.vectors[i]);
					});
					this.store.saveVectors(made.model, kept);
					fresh.forEach((paper, i) => similarity.set(paper, vectors[i] ? cosine(meaning.vector, vectors[i]!) : 0));
				} else {
					embedded = false;
					this.log.warn(`Papers not embedded (${made.reason}): ${made.message}; ranking by keywords`);
				}
			}
			if (first) {
				update({ phase: 'screening' });
			}
			// the first screening, of the closest of them -- all of them, unless the pool is very large
			const closest = [...fresh].sort((a, b) => (similarity.get(b) ?? 0) - (similarity.get(a) ?? 0)).slice(0, Math.max(0, SCREEN_LIMIT - rating.size));
			const before = rating.size;
			update({ ranking: embedded ? 'embeddings' : 'keywords', screened: before, toScreen: before + closest.length });
			const ratings = await worker.screen(topic, closest, token, rated => update({ screened: before + rated }), examples);
			closest.forEach((paper, i) => {
				if (ratings[i] !== undefined) {
					rating.set(paper, ratings[i]!);
				}
			});
		};
		const answering = () => pool.papers.filter(paper => (rating.get(paper) ?? 0) >= SCREENED_RELEVANT && !judged.disliked.has(paper.fingerprint));

		// 3. what the candidates lack is added, and they are screened against the question
		update({ phase: 'ranking' });
		await assess(pool.papers, true);

		// 4. wider than the databases' first answers
		const widened: string[] = [];
		const widen = (line: string) => { widened.push(line); update({ phase: 'widening', widened: [...widened], candidates: pool.papers.length }); };
		if (config.get<boolean>('followCitations') !== false) {
			// the citation trail of the best papers so far: what they cite, what cites them, what is like them
			const liked = pool.papers.filter(paper => judged.liked.some(l => l.fingerprint === paper.fingerprint));
			const best = pool.papers.filter(paper => (rating.get(paper) ?? 0) >= SEED_RATING && !liked.includes(paper)).sort((a, b) => (rating.get(b) ?? 0) - (rating.get(a) ?? 0));
			const seeds = [...liked, ...best].filter(paper => paper.doi && !judged.disliked.has(paper.fingerprint)).slice(0, SEEDS);
			if (seeds.length) {
				update({ phase: 'widening', widened: [`Following the citations of the ${seeds.length} best papers so far...`] });
				const trail = await chaseCitations(seeds, { openAlex: http(6), semanticScholar: http(semanticScholarApiKey ? 1 : 0.5) }, { email, openAlexApiKey, semanticScholarApiKey }, signal);
				for (const failure of trail.failed) {
					this.log.warn(`Citation trail: ${failure}`);
				}
				const fresh = pool.addAll(trail.papers);
				if (fresh.length) {
					await assess(fresh);
				}
				widen(`Citation trail of the ${seeds.length} best papers: ${fresh.length} new paper${fresh.length === 1 ? '' : 's'}, ${fresh.filter(paper => (rating.get(paper) ?? 0) >= SCREENED_RELEVANT).length} of them on the question`);
			}
		}
		if (answering().length < wanted) {
			// too few answer the question: a second search, in the words of the papers that do
			const have = answering().length;
			update({ phase: 'widening', widened: [...widened, `Only ${have} papers answer the question so far: searching again with other words...`] });
			const again = await ai.rewriteQueries(topic, plan, answering().sort((a, b) => (rating.get(b) ?? 0) - (rating.get(a) ?? 0)).slice(0, 8).map(paper => paper.title), token);
			if (again) {
				this.log.info(`"${topic}", second search: ${JSON.stringify(again)}`);
				const fresh = pool.addAll(await searchAll(engines, again, limit, signal, () => { }));
				if (fresh.length) {
					await assess(fresh);
				}
				widen(`Second search with other words: ${fresh.length} new paper${fresh.length === 1 ? '' : 's'}, ${answering().length - have} more on the question`);
			}
		}
		pool.finish();
		this.store.savePapers(pool.papers);

		// 5. the ranking, over everything gathered: closeness by meaning and by words together (by words alone without
		//    embeddings), the screening, and quality last
		const papers = pool.papers;
		const keyword = keywordScores(topic, papers.map(paper => `${paper.title} ${paper.abstract}`));
		const cosines = embedded ? papers.map(paper => similarity.get(paper) ?? 0) : undefined;
		const closeness = cosines ? hybridCloseness(cosines, keyword, this.store.keywordWeight()) : keyword;
		const screened = papers.map(paper => rating.get(paper));
		if (cosines) {
			// what was found relevant is what the keyword weight is fitted on, for the searches to come
			const meaningSpread = spread(cosines);
			const words = spread(keyword);
			const round = (value: number) => Math.round(value * 1000) / 1000;
			this.store.addJudgments(papers.flatMap((_paper, i): Judgment[] => screened[i] === undefined ? [] : [[round(meaningSpread[i]), round(words[i]), screened[i]! >= SCREENED_RELEVANT ? 1 : 0]]));
		}
		const studyTypes = papers.map(paper => classifyStudyType(paper.title, paper.abstract));
		const scores = rankScores(closeness, screened, papers.map((paper, i) => heuristicScore({ citationCount: paper.citationCount, year: paper.year, sourceCount: paper.sources.filter(source => source !== 'atelier').length, studyType: studyTypes[i], journalImpact: paper.journalImpact })));
		const ranked = papers
			.map((paper, i): CitedPaper => ({ ...paper, studyType: studyTypes[i], score: scores[i], screened: screened[i], similarity: cosines ? Math.round(cosines[i] * 1000) / 1000 : undefined }))
			.sort((a, b) => b.score - a.score);
		return { ranked, ranking: embedded ? 'embeddings' : 'keywords', yesNo, candidates: papers.length };
	}

	private async search(
		sessionId: string,
		base: Pick<StoredQuery, 'id' | 'prompt' | 'model' | 'createdAt'>,
		topic: string,
		ai: AiEngine,
		token: vscode.CancellationToken,
		update: (change: Partial<Run>) => void,
		onText: (text: string) => void
	): Promise<void> {
		const searchQuery = topic !== base.prompt ? topic : undefined;
		const config = vscode.workspace.getConfiguration('atelier');
		const abort = new AbortController();
		const cancelled = token.onCancellationRequested(() => abort.abort(new vscode.CancellationError()));
		try {
			update({ searchQuery });
			const worker = await this.workerFor(ai);
			// what the user has judged in this Session: papers that answer the question, and papers that don't
			const feedback = this.store.feedback(sessionId);
			const judged = {
				liked: Object.keys(feedback).filter(fingerprint => feedback[fingerprint] === 1).map(fingerprint => this.store.paper(fingerprint)).filter((paper): paper is Paper => !!paper),
				disliked: new Set(Object.keys(feedback).filter(fingerprint => feedback[fingerprint] === -1))
			};
			const gathered = await this.gather(topic, judged, ai, worker, token, abort.signal, update);
			if (!gathered) {
				this.store.addQuery(sessionId, { ...base, route: 'search', searchQuery, synthesis: 'No papers were found for this question in the databases. Try other words, or a broader question.', papers: [], candidates: 0 });
				return;
			}
			const { ranked, ranking, yesNo, candidates } = gathered;

			// The AI reads them: the screening proper, and each paper's details. Down the ranking until enough of them
			// answer the question, or the limit on papers read is reached: a paper screened out is replaced by the next
			// best. Papers the first screening found off-topic, or the user judged out, are not read; one with neither
			// abstract nor open-access full text can't be.
			const wanted = Math.max(1, config.get<number>('referencesWanted') ?? 20);
			const onTopic = ranked.filter(paper => (paper.screened === undefined || paper.screened >= OFF_TOPIC) && !judged.disliked.has(paper.fingerprint));
			const offTopic = ranked.length - onTopic.length;
			const readable = onTopic.filter(paper => paper.abstract || paper.pmcid || paper.doi || paper.pmid).slice(0, Math.max(wanted, config.get<number>('papersToRead') ?? 60));
			const readFullText = config.get<boolean>('readFullText') !== false;

			// a first look at the answer, from the top abstracts, while the papers are read
			let previewing = true;
			let previewed = 0;
			const top = readable.filter(paper => paper.abstract).slice(0, 8);
			if (top.length >= 3) {
				void worker.quickAnswer(topic, top, token, preview => {
					if (previewing && Date.now() - previewed > 150) {
						previewed = Date.now();
						update({ preview });
					}
				}).then(preview => { if (previewing) { update({ preview }); } }, error => this.log.warn(`No first look: ${error instanceof Error ? error.message : String(error)}`));
			}

			const toRead: CitedPaper[] = [];
			const found: FoundPaper[] = [];
			let relevant = 0;
			update({ phase: 'reading', read: 0, toRead: readable.length, relevant, wanted, offTopic, candidates, ranking });
			const done = (paper: CitedPaper) => {
				toRead.push(paper);
				if (paper.extraction?.isRelevant) {
					relevant++;
					found.push({
						fingerprint: paper.fingerprint, title: paper.title, relevance: paper.extraction.relevance, answer: paper.extraction.answer,
						byline: `${paper.authors.length ? `${paper.authors[0]}${paper.authors.length > 1 ? ' et al.' : ''}` : 'Unknown authors'}${paper.year ? ` · ${paper.year}` : ''}`
					});
				}
				update({ read: toRead.length, relevant, found: [...found] });
			};
			const keep = (paper: CitedPaper, extraction: Extraction | undefined, before?: Extraction) => {
				paper.extraction = extraction ?? before;
				if (extraction) {
					this.store.saveExtraction(paper.fingerprint, topic, extraction);
				}
				done(paper);
			};
			for (let cursor = 0; cursor < readable.length && relevant < wanted;) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				// a share of the ranking at a time: the first as many as are wanted, then as many as are still missing
				const size = cursor === 0 ? wanted + 4 : Math.max(6, Math.ceil((wanted - relevant) * 1.5));
				const share = readable.slice(cursor, cursor + size);
				cursor += share.length;
				if (readFullText) {
					// which of them are open access in Europe PMC: those are read from their full text
					await findPmcids(share, new HttpClient({ userAgent: this.userAgent, requestsPerSecond: 6, retries: 1 }), abort.signal);
					this.store.savePapers(share);
				}
				// What was read of a paper for this topic before is kept -- unless it was read from the abstract alone
				// and its full text can now be had: the table's facts (who was studied, how many, how) are the full text's.
				const whole: { paper: CitedPaper; fullText: string; before?: Extraction }[] = [];
				const abstracts: CitedPaper[] = [];
				await inParallel(share, 8, async paper => {
					const before = this.store.extraction(paper.fingerprint, topic);
					const fullText = before?.fullText ? '' : await this.fullText(paper, abort.signal);
					if (before && (before.fullText || !fullText)) {
						paper.extraction = before;
						done(paper);
					} else if (fullText) {
						whole.push({ paper, fullText, before });
					} else if (paper.abstract) {
						abstracts.push(paper);
					}
				});
				// a paper with its full text is a request of its own; abstracts go several to a request
				const jobs: (() => Promise<void>)[] = whole.map(({ paper, fullText, before }) => async () => keep(paper, await worker.extract(topic, yesNo, paper, fullText, token), before));
				for (let i = 0; i < abstracts.length; i += READ_BATCH) {
					const group = abstracts.slice(i, i + READ_BATCH);
					jobs.push(async () => {
						const extractions = await worker.extractBatch(topic, yesNo, group, token);
						group.forEach((paper, j) => keep(paper, extractions[j]));
					});
				}
				await inParallel(jobs, READ_CONCURRENCY, job => {
					if (token.isCancellationRequested) {
						throw new vscode.CancellationError();
					}
					return job();
				});
			}
			previewing = false;

			// the references: the papers that answer the question, best evidence first -- now that each has been read, how
			// directly it answers, then how strong a study it is (its design, then citations and journal). A paper's number
			// is its place.
			const cited = readable.filter(paper => paper.extraction?.isRelevant);
			if (!cited.length) {
				this.store.addQuery(sessionId, { ...base, route: 'search', searchQuery, synthesis: `${candidates} papers were found, but none answered this question: the first screening set ${offTopic} aside as off-topic, and none of the ${toRead.length} read passed. Try other words, or a broader question.`, papers: [], candidates, read: toRead.length, offTopic, ranking });
				return;
			}
			for (const paper of cited) {
				paper.score = evidenceScore(paper.extraction!.relevance, evidenceQuality(paper));
			}
			cited.sort((a, b) => b.score - a.score);

			// the Synthesis, from the papers that passed; and for a yes/no question, how they answer it
			const meter = yesNo ? computeMeter(cited.map(paper => ({ stance: paper.extraction?.stance, studyType: paper.studyType, citationCount: paper.citationCount }))) : undefined;
			update({ phase: 'synthesizing' });
			const synthesis = await ai.synthesize(topic, cited, token, onText);
			this.store.addQuery(sessionId, { ...base, route: 'search', searchQuery, synthesis: tidyCitations(synthesis), papers: cited.map(toQueryPaper), candidates, read: toRead.length, offTopic, ranking, meter });
		} finally {
			cancelled.dispose();
		}
	}

	/**
	 * How well the search and the ranking find the papers a question should bring back: for each question the
	 * candidates are gathered and ranked as for a search (nothing is read, nothing is written), and each expected paper
	 * is looked for in the ranking.
	 */
	async benchmark(questions: readonly { question: string; expected: readonly string[] }[], modelId: string, token: vscode.CancellationToken, progress: (done: number, question: string) => void): Promise<BenchmarkResult[]> {
		const [model] = await vscode.lm.selectChatModels({ id: modelId });
		if (!model) {
			throw new Error('That AI model is no longer available.');
		}
		const ai = new AiEngine(model, this.log);
		const worker = await this.workerFor(ai);
		const abort = new AbortController();
		const cancelled = token.onCancellationRequested(() => abort.abort(new vscode.CancellationError()));
		const results: BenchmarkResult[] = [];
		try {
			for (const [i, { question, expected }] of questions.entries()) {
				progress(i, question);
				const started = Date.now();
				const gathered = await this.gather(question, { liked: [], disliked: new Set() }, ai, worker, token, abort.signal, () => { });
				const ranked = gathered?.ranked ?? [];
				const place = (doi: string) => {
					const wanted = normalizeDoi(doi);
					const at = ranked.findIndex(paper => paper.doi === wanted);
					return { doi: wanted ?? doi, rank: at < 0 ? undefined : at + 1, screened: at < 0 ? undefined : ranked[at].screened };
				};
				results.push({ question, candidates: ranked.length, seconds: Math.round((Date.now() - started) / 1000), ranking: gathered?.ranking, expected: expected.map(place) });
			}
		} finally {
			cancelled.dispose();
		}
		return results;
	}
}

export interface BenchmarkResult {
	readonly question: string;
	readonly candidates: number;
	readonly seconds: number;
	readonly ranking?: Ranking;
	/** Each expected paper: where it came in the ranking (absent: not found at all) and how the screening rated it. */
	readonly expected: readonly { readonly doi: string; readonly rank?: number; readonly screened?: number }[];
}

function toQueryPaper(paper: CitedPaper): QueryPaper {
	return { fingerprint: paper.fingerprint, score: paper.score, similarity: paper.similarity, extraction: paper.extraction };
}

/** Runs `work` over the items, `limit` at a time. The first failure stops the rest. */
async function inParallel<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			await work(items[next++]);
		}
	}));
}

/** An error in words for the user. */
function describe(error: unknown): string {
	if (error instanceof vscode.LanguageModelError) {
		if (error.code === vscode.LanguageModelError.NoPermissions.name) {
			return 'Atelier was not allowed to use the AI model. Ask again and allow it when DataSuite asks.';
		}
		if (error.code === vscode.LanguageModelError.Blocked.name) {
			return `The AI model refused the request${error.message ? `: ${error.message}` : '.'}`;
		}
		if (error.code === vscode.LanguageModelError.NotFound.name) {
			return 'That AI model is no longer available. Choose another.';
		}
	}
	return error instanceof Error ? error.message : String(error);
}
