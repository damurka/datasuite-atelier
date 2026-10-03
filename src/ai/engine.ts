/*---------------------------------------------------------------------------------------------
 *  Atelier: what the AI does -- plans the databases' queries, screens a paper and extracts its details, writes the
 *  Synthesis, decides whether a follow-up needs a new search, and answers from the papers already read. The model is
 *  one of DataSuite's chat models (vscode.lm), the one the user chose.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CitedPaper, Extraction, Paper, Route, Stance } from '../shared/api';
import { parseModelJson, stripThinking, truncate } from '../core/text';
import { focusFullText } from '../search/enrich';
import { SearchPlan } from '../search/search';

export interface ChatTurn {
	readonly role: 'user' | 'assistant';
	readonly content: string;
}

const PLAN_PROMPT = `You are an Expert Medical and Academic Literature Query Planner.
Your task is to translate a user's natural language research topic into optimized search queries for academic databases (PubMed, Europe PMC, OpenAlex, Semantic Scholar).

Rules:
1. Extract the core scientific, medical, or sociological concepts.
2. DO NOT let geographic terms overly restrict the search. If a specific country is mentioned (e.g., "Kenya"), you MUST broadly expand the geography (e.g., "Kenya" OR "East Africa" OR "LMIC" OR "Sub-Saharan Africa") to maximize recall.
3. Remove stop words and unnecessary conversational phrasing.
4. Write several queries, each in different words -- not the same words reordered: synonyms, another discipline's vocabulary for the same thing, a broader term, a narrower one. A paper that never uses the user's words must still be found.
5. Output ONLY a valid JSON object.

Output Schema:
{
"pubmed_queries": ["<boolean string>", "<a second, in other words>"],
"europe_pmc_queries": ["<boolean string>", "<a second, in other words>"],
"keyword_queries": ["<clean keyword string>", "<the same in other words>", "<broader, or another discipline's words>"],
"is_yes_no_question": <true if the topic asks whether something is so (answerable with yes or no), else false>
}`;

const EXTRACT_PROMPT = `You are a rigorous Academic Data Extraction and Quality Control AI.
Your task is to analyze a scientific paper's abstract (and full text, if provided) against a user's research query.

Rules:
1. Assess Relevance: Rate how directly this paper answers the user's query on a scale of 0 to 100. If it is entirely unrelated, set "is_relevant" to false.
2. Extract Parameters: Identify the target population, study methodology, core results, measured outcomes, sample size (N), number of included studies (for meta-analyses), duration, and geographic location.
3. If a parameter is not explicitly stated in the text, you MUST output "-". Do not guess.
   When "full_text" is provided, take the population, the sample size and the methods FROM THE FULL TEXT (its Methods and Results), not from the abstract: the exact number analysed (not the number invited), who they were (age, sex, setting, how they were recruited), and the methodology in full -- the design, the setting and period, the sampling, the instruments or data sources, and the analysis. Where the abstract and the full text differ, the full text is right.
4. Provide a punchy, 1-sentence "answer" summarizing the paper's main takeaway regarding the user's query.
5. Stance: if the query is a yes/no question, say what THIS paper's findings answer: "yes", "no", "possibly" (suggestive but weak or indirect evidence), "mixed" (findings point both ways), or "n/a" when the paper takes no side or the query is not a yes/no question.
6. Spin Check: if full text is provided, verify that the abstract does not exaggerate the findings. Without full text, set "is_abstract_misleading" to false and "fidelity_rationale" to "-".

Output ONLY a valid JSON object matching this exact schema:
{
"is_relevant": true,
"ai_rank_score": 85,
"answer": "<1-sentence direct answer>",
"population": "<who was studied: age, sex, setting, how recruited>",
"methods": "<study design; with full text: design, setting and period, sampling, instruments or data sources, analysis>",
"results": "<main findings>",
"outcomes": "<measured variables>",
"sample_size": "<the number analysed, as an integer, or '-'>",
"study_count": "<integer or '-'>",
"duration": "<timeframe or '-'>",
"country": "<location or '-'>",
"stance": "yes" | "no" | "possibly" | "mixed" | "n/a",
"is_abstract_misleading": false,
"fidelity_rationale": "<why the abstract overstates the findings, or 'Accurate'>"
}`;

/** The same reading, of several papers in one request: the answer holds each paper's object under its number. */
const EXTRACT_BATCH_PROMPT = `${EXTRACT_PROMPT.replace('Output ONLY a valid JSON object matching this exact schema:', 'You are given SEVERAL papers, numbered. Read each on its own: nothing from one paper may enter another\'s answer.\n\nFor EACH paper, an object matching this exact schema:')}

Output ONLY a valid JSON object holding every paper's object under its number:
{"papers": {"1": { ... }, "2": { ... }}}`;

const REWRITE_PROMPT = `You are an Expert Medical and Academic Literature Query Planner.
A first search found too few papers that answer the user's topic. You are given the topic, the queries already tried, and the titles of the papers that DID answer it.

Write NEW queries that will find papers the first ones missed:
1. Use the vocabulary of the papers that answered: the terms their titles use that the first queries did not.
2. Drop what made the first queries narrow: a place, a year, an exact phrase, a rare word. Prefer the broader concept.
3. Do not repeat a query already tried, or the same words reordered.
4. Output ONLY a valid JSON object.

Output Schema:
{
"pubmed_queries": ["<boolean string>", "<a second, in other words>"],
"europe_pmc_queries": ["<boolean string>", "<a second, in other words>"],
"keyword_queries": ["<clean keyword string>", "<the same in other words>", "<broader>"]
}`;

const QUICK_PROMPT = `You are Atelier's research assistant. A full literature synthesis is being prepared; while it is, give the user a FIRST LOOK.

Rules:
1. From the abstracts provided, answer the user's topic in 3 to 5 sentences: what the evidence most consistently says, and the main disagreement or caveat if there is one.
2. Base it ENTIRELY on the abstracts. Do not introduce outside knowledge.
3. Plain prose. No heading, no list, no citations, no closing remark about a fuller synthesis.`;

const SCREEN_PROMPT = `You are a rigorous screener for a literature review.
For each numbered paper, rate from 0 to 100 how directly its findings could ANSWER the user's query.

Rules:
1. Judge whether the paper answers the query, not whether it shares its subject. A paper on the same subject that studies a different question, population, exposure or outcome rates below 30.
2. A paper that answers the query in other words (synonyms, another discipline's vocabulary, a broader or narrower term) rates as high as one that uses the query's own words.
3. Do not rate a paper up for being well known, recent, large, or a review: only for answering the query.
4. A paper with no abstract is judged on its title; when the title cannot tell you, rate it 40.
5. Output ONLY a valid JSON object with one entry for every paper number.

Output Schema:
{"scores": {"1": 85, "2": 10}}`;

const SUMMARY_PROMPT = `You are Atelier's paper summarizer.
Summarize ONE scientific paper for a researcher who is investigating a specific topic.

Rules:
1. Write 4 to 6 sentences: what was studied and how (design, population, setting, sample size), the findings that bear on the topic with their numbers (effect sizes, percentages, confidence intervals) where the text gives them, and the limitations that matter for the topic.
2. Use ONLY the provided text. If the paper says little about the topic, say so plainly.
3. Plain prose in Markdown. No title, no bullet list, no citations.`;

const SYNTHESIS_PROMPT = `You are the Atelier Synthesizer, an expert at writing academic literature reviews.
Your task is to read the provided paper extracts and write a highly structured, objective summary answering the user's topic.

Rules:
1. Base your answer ENTIRELY on the provided insights. Do not introduce outside knowledge.
2. Always start with a 2-to-3 sentence introductory paragraph summarizing the broad consensus or main takeaway.
3. Dynamically choose the best formatting for the body:
- If the papers discuss distinct variables/causes, use a "Key Factors" Markdown table.
- If the papers debate an issue, use a "Pros & Cons" list.
- If the query asks for a definition, use thematic bullet points.
4. You MUST cite the source of every claim using bracketed numbers corresponding to the paper index (e.g., [1]).
CRITICAL: If citing multiple papers, use separate brackets like [1][2]. DO NOT use comma-separated formats like [1, 2].
5. Weigh the evidence: where papers disagree, prefer systematic reviews and trials over single observational studies, and say so.
6. Conclude with a brief 1-sentence wrap-up identifying gaps in the literature if applicable.
7. The papers are numbered by the strength of their evidence for the topic: [1] is the best, and it weakens as the numbers rise. Follow that order: open with what the lowest-numbered papers show, build each point on its strongest papers first, and bring in the higher-numbered ones as support or contrast. When several papers support one claim, cite them in ascending order.
8. Write Markdown. Do not add a title or a reference list: the references are shown beside your text.`;

const ROUTE_PROMPT = `You are an intelligent routing agent for an academic research engine.

Task 1: Evaluate if the user's query can be confidently answered using ONLY the provided literature context.
- If YES, route to 'CHAT'.
- If NO (asking about a new demographic or new question), route to 'SEARCH'.

Task 2: If SEARCH, combine the original topic and the follow-up into a single standalone search query.

Return ONLY a valid JSON object matching this exact schema:
{"intent": "SEARCH" or "CHAT", "standalone_query": "merged query here or null"}`;

const CHAT_PROMPT = `You are Atelier's specialized Academic Research Assistant.
Your task is to answer the user's follow-up questions by conducting a "deep dive" into the provided literature context.

Rules:
1. CLOSED-BOOK: Your only source of truth is the provided Context. If the context does not contain the answer, you must explicitly state: "The provided literature does not contain information to answer this."
2. Maintain an objective, academic tone. Avoid hyperbole.
3. You MUST cite your claims using the bracketed numbers from the context headers (e.g., [1]).
CRITICAL: If citing multiple papers, use separate brackets like [1][2]. DO NOT use comma-separated formats like [1, 2].
4. Write what was asked for: an answer to a question, the user's own text rewritten with citations woven in, or the requested piece (an abstract, an introduction) in that genre's conventions.`;

const STANCES: readonly Stance[] = ['yes', 'possibly', 'mixed', 'no'];
/** The first screening: papers a request, requests at once, and how much of each abstract is shown. */
const SCREEN_BATCH = 20;
const SCREEN_CONCURRENCY = 4;
const SCREEN_CHARS = 700;
/** How much of a paper's full text the AI is given: its methods and results first, then the rest as room allows. */
const FULL_TEXT_CHARS = 24000;

const field = (data: Record<string, unknown>, key: string): string => {
	const value = data[key];
	const text = value === undefined || value === null ? '' : String(value).trim();
	return text || '-';
};

function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise(resolve => {
		const listener = token.onCancellationRequested(() => { clearTimeout(timer); listener.dispose(); resolve(); });
		const timer = setTimeout(() => { listener.dispose(); resolve(); }, ms);
	});
}

/** An error trying again cannot fix: no model, no permission, no quota, or the request itself refused. */
function isFinal(error: unknown): boolean {
	if (error instanceof vscode.CancellationError) {
		return true;
	}
	if (error instanceof vscode.LanguageModelError) {
		return error.code === vscode.LanguageModelError.NoPermissions.name || error.code === vscode.LanguageModelError.NotFound.name || error.code === vscode.LanguageModelError.Blocked.name;
	}
	return false;
}

export class AiEngine {

	constructor(
		private readonly model: vscode.LanguageModelChat,
		private readonly log: vscode.LogOutputChannel
	) { }

	/** The model's answer to the messages, as text; `onText` hears it as it is written. Tried up to three times. */
	private async complete(messages: vscode.LanguageModelChatMessage[], justification: string, token: vscode.CancellationToken, onText?: (text: string) => void, accept?: (text: string) => void): Promise<string> {
		for (let attempt = 1; ; attempt++) {
			try {
				const response = await this.model.sendRequest(messages, { justification }, token);
				let text = '';
				for await (const part of response.text) {
					text += part;
					onText?.(text);
				}
				text = stripThinking(text);
				if (!text) {
					throw new Error('The model answered nothing.');
				}
				accept?.(text);
				return text;
			} catch (error) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				if (isFinal(error) || attempt >= 3) {
					throw error;
				}
				this.log.warn(`${justification}: attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); trying again`);
				await sleep(2000 * attempt, token);
			}
		}
	}

	/** An answer that must be a JSON object: one that isn't is asked for again. */
	private async json(system: string, input: string, justification: string, token: vscode.CancellationToken): Promise<Record<string, unknown>> {
		let parsed: Record<string, unknown> | undefined;
		// the stable chat API has no system role: the instructions are the first user message
		await this.complete([vscode.LanguageModelChatMessage.User(system), vscode.LanguageModelChatMessage.User(input)], justification, token, undefined, text => { parsed = parseModelJson(text); });
		return parsed!;
	}

	/** The queries of a plan the AI wrote, for each database; `fallback` where it gave none. */
	private toPlan(data: Record<string, unknown>, fallback?: string): SearchPlan {
		const list = (...keys: string[]): string[] => {
			for (const key of keys) {
				const value = data[key];
				const queries = (Array.isArray(value) ? value : [value]).filter((query): query is string => typeof query === 'string').map(query => query.trim()).filter(query => query && query.toLowerCase() !== 'null');
				if (queries.length) {
					return [...new Set(queries)].slice(0, 3);
				}
			}
			return fallback ? [fallback] : [];
		};
		const keywords = list('keyword_queries', 'openalex_query', 'semantic_scholar_query');
		return {
			pubmed: list('pubmed_queries', 'pubmed_query'),
			europepmc: list('europe_pmc_queries', 'europe_pmc_query'),
			openalex: keywords,
			semanticscholar: keywords,
			crossref: keywords.slice(0, 2),
			// slow to answer: one query each
			core: keywords.slice(0, 1),
			arxiv: keywords.slice(0, 1)
		};
	}

	/**
	 * The topic as queries for each database -- several, in different words -- and whether it is a yes/no question.
	 * Without a usable plan, the topic's own words, and its first word says whether it asks yes or no.
	 */
	async planQueries(topic: string, token: vscode.CancellationToken): Promise<{ plan: SearchPlan; yesNo: boolean }> {
		const fallback = topic.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
		let plan: Record<string, unknown> = {};
		try {
			plan = await this.json(PLAN_PROMPT, `Topic: ${topic}`, 'Atelier plans the literature search', token);
		} catch (error) {
			if (isFinal(error)) {
				throw error;
			}
			this.log.warn(`Query planning failed (${error instanceof Error ? error.message : String(error)}); searching for the topic's words`);
		}
		const yesNo = typeof plan.is_yes_no_question === 'boolean'
			? plan.is_yes_no_question
			: /^\s*(is|are|was|were|does|do|did|can|could|should|will|would|has|have|had)\b/i.test(topic);
		return { plan: this.toPlan(plan, fallback), yesNo };
	}

	/**
	 * Other queries for a topic whose first search found too few papers that answer it, in the words of those that
	 * did. Undefined when the AI gives none.
	 */
	async rewriteQueries(topic: string, tried: SearchPlan, answering: readonly string[], token: vscode.CancellationToken): Promise<SearchPlan | undefined> {
		try {
			const before = [...new Set(Object.values(tried).flat())].map(query => `- ${query}`).join('\n');
			const titles = answering.length ? answering.map(title => `- ${title}`).join('\n') : '(none)';
			const data = await this.json(REWRITE_PROMPT, `Topic: ${topic}\n\nQueries already tried:\n${before}\n\nPapers that answered the topic:\n${titles}`, 'Atelier widens the literature search', token);
			const plan = this.toPlan(data);
			return Object.values(plan).some(queries => queries.length) ? plan : undefined;
		} catch (error) {
			if (isFinal(error)) {
				throw error;
			}
			this.log.warn(`No second search (${error instanceof Error ? error.message : String(error)})`);
			return undefined;
		}
	}

	/** What the AI wrote of one paper, as an Extraction. */
	private toExtraction(data: Record<string, unknown>, yesNo: boolean, fullText: boolean): Extraction {
		const relevance = Number(data.ai_rank_score);
		const stance = String(data.stance ?? '').toLowerCase();
		const misleading = fullText && (data.is_abstract_misleading === true || data.is_abstract_misleading === 'true');
		return {
			stance: yesNo && (STANCES as readonly string[]).includes(stance) ? stance as Stance : undefined,
			fullText: fullText ? true : undefined,
			misleadingAbstract: misleading || undefined,
			fidelity: misleading ? field(data, 'fidelity_rationale') : undefined,
			isRelevant: data.is_relevant === true || data.is_relevant === 'true',
			relevance: Number.isFinite(relevance) ? Math.max(0, Math.min(100, Math.round(relevance))) : 0,
			answer: field(data, 'answer'),
			population: field(data, 'population'),
			methods: field(data, 'methods'),
			results: field(data, 'results'),
			outcomes: field(data, 'outcomes'),
			sampleSize: field(data, 'sample_size'),
			studyCount: field(data, 'study_count'),
			duration: field(data, 'duration'),
			country: field(data, 'country')
		};
	}

	/**
	 * Screens several papers against the topic and extracts their details, from their abstracts, in one request. A
	 * paper the answer leaves out is read on its own.
	 */
	async extractBatch(topic: string, yesNo: boolean, papers: readonly Paper[], token: vscode.CancellationToken): Promise<(Extraction | undefined)[]> {
		if (papers.length === 1) {
			return [await this.extract(topic, yesNo, papers[0], '', token)];
		}
		const out: (Extraction | undefined)[] = new Array(papers.length).fill(undefined);
		try {
			const list = papers.map((paper, i) => `[${i + 1}] ${JSON.stringify({ title: paper.title, abstract: truncate(paper.abstract, 4000) })}`).join('\n');
			const data = await this.json(EXTRACT_BATCH_PROMPT, `Query: ${topic}\nYes/no question: ${yesNo}\nPapers:\n${list}`, 'Atelier reads papers', token);
			const answers = (data.papers && typeof data.papers === 'object' ? data.papers : data) as Record<string, unknown>;
			papers.forEach((_paper, i) => {
				const answer = answers[String(i + 1)];
				if (answer && typeof answer === 'object') {
					out[i] = this.toExtraction(answer as Record<string, unknown>, yesNo, false);
				}
			});
		} catch (error) {
			if (isFinal(error)) {
				throw error;
			}
			this.log.warn(`${papers.length} papers were not read together (${error instanceof Error ? error.message : String(error)}); reading each on its own`);
		}
		await Promise.all(papers.map(async (paper, i) => { out[i] ??= await this.extract(topic, yesNo, paper, '', token); }));
		return out;
	}

	/** A first look at the answer, from the top abstracts, as it is written. */
	quickAnswer(topic: string, papers: readonly Paper[], token: vscode.CancellationToken, onText: (text: string) => void): Promise<string> {
		const context = papers.map((paper, i) => `[${i + 1}] ${paper.title}${paper.year ? ` (${paper.year})` : ''}\n${truncate(paper.abstract, 1500)}`).join('\n\n');
		return this.complete([vscode.LanguageModelChatMessage.User(QUICK_PROMPT), vscode.LanguageModelChatMessage.User(`Topic: ${topic}\n\nAbstracts:\n${context}`)], 'Atelier takes a first look', token, onText);
	}

	/**
	 * Screens one paper against the topic and extracts its details, from its abstract and (when given) its full text.
	 * A paper that can't be read is not relevant.
	 */
	async extract(topic: string, yesNo: boolean, paper: Paper, fullText: string, token: vscode.CancellationToken): Promise<Extraction | undefined> {
		const payload = JSON.stringify({ title: paper.title, abstract: paper.abstract ? truncate(paper.abstract, 6000) : undefined, full_text: fullText ? focusFullText(fullText, FULL_TEXT_CHARS) : undefined });
		try {
			return this.toExtraction(await this.json(EXTRACT_PROMPT, `Query: ${topic}\nYes/no question: ${yesNo}\nPaper Data: ${payload}`, 'Atelier reads a paper', token), yesNo, !!fullText);
		} catch (error) {
			if (isFinal(error)) {
				throw error;
			}
			this.log.warn(`Could not read "${truncate(paper.title, 60)}": ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	/**
	 * The first screening: every candidate rated 0-100 against the question from its title and the opening of its
	 * abstract, a batch a request. A paper whose batch couldn't be rated stays unrated (undefined).
	 */
	async screen(topic: string, papers: readonly Paper[], token: vscode.CancellationToken, onProgress: (rated: number) => void, judged?: { relevant: readonly string[]; irrelevant: readonly string[] }): Promise<(number | undefined)[]> {
		// what the user has judged of papers for this question shows the screening what answering it means
		const guidance = judged && (judged.relevant.length || judged.irrelevant.length)
			? `\n\nThe user has judged some papers for this query. Rate others as these judgments imply.${judged.relevant.length ? `\nAnswer the query:\n${judged.relevant.slice(0, 8).map(title => `- ${title}`).join('\n')}` : ''}${judged.irrelevant.length ? `\nDo NOT answer the query:\n${judged.irrelevant.slice(0, 8).map(title => `- ${title}`).join('\n')}` : ''}`
			: '';
		const ratings: (number | undefined)[] = new Array(papers.length).fill(undefined);
		const batches: number[][] = [];
		for (let i = 0; i < papers.length; i += SCREEN_BATCH) {
			batches.push(papers.slice(i, i + SCREEN_BATCH).map((_paper, j) => i + j));
		}
		let rated = 0;
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(SCREEN_CONCURRENCY, batches.length) }, async () => {
			while (next < batches.length) {
				const batch = batches[next++];
				const list = batch.map((index, n) => {
					const paper = papers[index];
					return `[${n + 1}] ${paper.title}${paper.year ? ` (${paper.year})` : ''}\n${paper.abstract ? truncate(paper.abstract, SCREEN_CHARS) : '(no abstract)'}`;
				}).join('\n\n');
				try {
					const data = await this.json(SCREEN_PROMPT, `Query: ${topic}${guidance}\n\nPapers:\n${list}`, 'Atelier screens the papers', token);
					const scores = (data.scores && typeof data.scores === 'object' ? data.scores : data) as Record<string, unknown>;
					batch.forEach((index, n) => {
						const score = Number(scores[String(n + 1)]);
						if (Number.isFinite(score)) {
							ratings[index] = Math.max(0, Math.min(100, Math.round(score)));
						}
					});
				} catch (error) {
					if (isFinal(error)) {
						throw error;
					}
					this.log.warn(`A batch of ${batch.length} papers was not screened: ${error instanceof Error ? error.message : String(error)}`);
				}
				rated += batch.length;
				onProgress(rated);
			}
		}));
		return ratings;
	}

	/** A Paper Summary: what one paper says about the topic. */
	summarize(topic: string, paper: Paper, fullText: string, token: vscode.CancellationToken): Promise<string> {
		const payload = JSON.stringify({ title: paper.title, journal: paper.journal || undefined, year: paper.year, abstract: truncate(paper.abstract, 6000), full_text: fullText ? focusFullText(fullText, FULL_TEXT_CHARS) : undefined });
		return this.complete([vscode.LanguageModelChatMessage.User(SUMMARY_PROMPT), vscode.LanguageModelChatMessage.User(`Topic: ${topic}\nPaper: ${payload}`)], 'Atelier summarizes a paper', token);
	}

	/** The Synthesis for a topic from the papers that passed the screening (`[n]` is `papers[n - 1]`). */
	synthesize(topic: string, papers: readonly CitedPaper[], token: vscode.CancellationToken, onText: (text: string) => void): Promise<string> {
		const context = papers.map((paper, i) => {
			const e = paper.extraction;
			const details = [
				paper.year ? `Year: ${paper.year}` : '',
				paper.studyType !== 'unspecified' ? `Design: ${paper.studyType}` : '',
				e && e.methods !== '-' ? `Methods: ${e.methods}` : '',
				e && e.population !== '-' ? `Population: ${e.population}` : '',
				e && e.sampleSize !== '-' ? `N: ${e.sampleSize}` : '',
				e && e.country !== '-' ? `Location: ${e.country}` : '',
				e && e.results !== '-' ? `Results: ${e.results}` : '',
				e?.stance ? `Answers the question: ${e.stance}` : ''
			].filter(Boolean).join('; ');
			return `[${i + 1}] ${paper.title} - ${e?.answer ?? '-'}${details ? `\n    ${details}` : ''}`;
		}).join('\n');
		return this.complete(
			[vscode.LanguageModelChatMessage.User(SYNTHESIS_PROMPT), vscode.LanguageModelChatMessage.User(`Topic: ${topic}\nContext:\n${context}`)],
			'Atelier writes the synthesis', token, onText);
	}

	/** Whether a follow-up can be answered from the papers already read, or needs a new search (and for what). */
	async route(query: string, topic: string, papers: readonly Paper[], token: vscode.CancellationToken): Promise<{ route: Route; searchQuery: string }> {
		const merged = `${topic} ${query}`;
		try {
			const context = papers.map(paper => `- ${paper.title}`).join('\n');
			const data = await this.json(ROUTE_PROMPT, `Original Topic: ${topic}\nContext:\n${context}\nFollow-up: ${query}`, 'Atelier decides whether to search again', token);
			const standalone = typeof data.standalone_query === 'string' ? data.standalone_query.trim() : '';
			return {
				route: String(data.intent ?? 'CHAT').toUpperCase().includes('SEARCH') ? 'search' : 'chat',
				searchQuery: standalone && standalone.toLowerCase() !== 'null' ? standalone : merged
			};
		} catch (error) {
			if (isFinal(error)) {
				throw error;
			}
			this.log.warn(`Routing failed (${error instanceof Error ? error.message : String(error)}); answering from the papers at hand`);
			return { route: 'chat', searchQuery: merged };
		}
	}

	/** An answer to the conversation's last message from the papers' abstracts alone (`[n]` is `papers[n - 1]`). */
	chat(history: readonly ChatTurn[], papers: readonly Paper[], token: vscode.CancellationToken, onText: (text: string) => void): Promise<string> {
		const context = papers.map((paper, i) => `[${i + 1}] ${paper.title}\n${truncate(paper.abstract, 6000)}`).join('\n\n');
		const messages = [vscode.LanguageModelChatMessage.User(`${CHAT_PROMPT}\n\nContext:\n${context}`)];
		// the last turns only, to keep within the model's window
		for (const turn of history.slice(-7)) {
			messages.push(turn.role === 'user' ? vscode.LanguageModelChatMessage.User(turn.content) : vscode.LanguageModelChatMessage.Assistant(turn.content));
		}
		return this.complete(messages, 'Atelier answers from the literature', token, onText);
	}
}
