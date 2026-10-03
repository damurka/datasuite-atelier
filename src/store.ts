/*---------------------------------------------------------------------------------------------
 *  Atelier: what is kept on this machine, in the extension's global storage -- every Paper met (once, by its
 *  Fingerprint), its embedding, what the AI last extracted from it, and the Sessions with their Queries. The papers'
 *  vectors make the store a memory: a new topic recalls the papers already known that are close to it, at no cost.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CitedPaper, Extraction, Meter, Paper, Query, Ranking, Route, Session, SessionSummary } from './shared/api';
import { classifyStudyType, cosine, fitKeywordWeight, Judgment } from './core/scoring';
import { topicKey } from './core/text';

/** A Paper as a Query cites it: what was true for that Query, beside the Paper itself. */
export interface QueryPaper {
	readonly fingerprint: string;
	readonly score: number;
	readonly similarity?: number;
	readonly extraction?: Extraction;
}

export interface StoredQuery {
	readonly id: string;
	readonly prompt: string;
	readonly route: Route;
	readonly searchQuery?: string;
	readonly synthesis: string;
	readonly model: string;
	readonly createdAt: number;
	readonly papers: QueryPaper[];
	readonly candidates?: number;
	readonly read?: number;
	readonly offTopic?: number;
	readonly ranking?: Ranking;
	readonly meter?: Meter;
}

export interface StoredSession {
	readonly id: string;
	readonly topic: string;
	summary: string;
	readonly createdAt: number;
	readonly queries: StoredQuery[];
	/** Paper Summaries, by Fingerprint. */
	summaries?: Record<string, string>;
	/** The user's judgments of papers for this Session, by Fingerprint: answers the question (1), doesn't (-1). */
	feedback?: Record<string, 1 | -1>;
}

interface StoredPaper extends Paper {
	/** The last extraction, and the topic it was made for. */
	extracted?: { topic: string; data: Extraction };
}

interface VectorFile {
	model: string;
	vectors: Record<string, string>;
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
	} catch {
		return fallback;
	}
}

const JUDGMENTS_KEPT = 4000;

const encode = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
const decode = (text: string) => {
	const bytes = Buffer.from(text, 'base64');
	return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4)).slice();
};

export class AtelierStore implements vscode.Disposable {

	private readonly papersFile: string;
	private readonly vectorsFile: string;
	private readonly sessionsFile: string;

	private readonly papers: Record<string, StoredPaper>;
	private readonly vectorFile: VectorFile;
	private readonly vectors = new Map<string, Float32Array>();
	private readonly sessions: StoredSession[];

	/** What the screenings so far found relevant, to fit the ranking's keyword weight on (the latest JUDGMENTS_KEPT). */
	private readonly judgmentsFile: string;
	private judgments: Judgment[];
	private fitted: number | undefined;

	private readonly dirty = new Set<'papers' | 'vectors' | 'sessions' | 'judgments'>();
	private timer: NodeJS.Timeout | undefined;

	private readonly _onDidChangeSessions = new vscode.EventEmitter<void>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	constructor(private readonly dir: string, private readonly log: vscode.LogOutputChannel) {
		this.papersFile = path.join(dir, 'papers.json');
		this.vectorsFile = path.join(dir, 'vectors.json');
		this.sessionsFile = path.join(dir, 'sessions.json');
		this.papers = readJson<Record<string, StoredPaper>>(this.papersFile, {});
		this.vectorFile = readJson<VectorFile>(this.vectorsFile, { model: '', vectors: {} });
		this.sessions = readJson<StoredSession[]>(this.sessionsFile, []);
		this.judgmentsFile = path.join(dir, 'judgments.json');
		this.judgments = readJson<Judgment[]>(this.judgmentsFile, []);
	}

	dispose(): void {
		this.flush();
		this._onDidChangeSessions.dispose();
	}

	private changed(what: 'papers' | 'vectors' | 'sessions' | 'judgments'): void {
		this.dirty.add(what);
		this.timer ??= setTimeout(() => this.flush(), 400);
	}

	/** Writes what changed (each file whole, through a temporary one so a crash never leaves half a file). */
	flush(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const files = { papers: [this.papersFile, this.papers], vectors: [this.vectorsFile, this.vectorFile], sessions: [this.sessionsFile, this.sessions], judgments: [this.judgmentsFile, this.judgments] } as const;
		for (const what of this.dirty) {
			const [file, data] = files[what];
			try {
				fs.mkdirSync(this.dir, { recursive: true });
				fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
				fs.renameSync(`${file}.tmp`, file);
			} catch (error) {
				this.log.error(`Could not save ${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.dirty.clear();
	}

	// ---- Papers

	/** Keeps the papers: a new one as it is; a known one gains what it lacked (what the AI extracted from it stays). */
	savePapers(papers: readonly Paper[]): void {
		for (const paper of papers) {
			if (!paper.fingerprint) {
				continue;
			}
			const known = this.papers[paper.fingerprint];
			const sources = [...new Set([...(known?.sources ?? []), ...paper.sources])].filter(source => source !== 'atelier');
			this.papers[paper.fingerprint] = { ...known, ...paper, sources, abstract: paper.abstract || known?.abstract || '', extracted: known?.extracted };
		}
		this.changed('papers');
	}

	/** What the AI extracted from the paper for this topic, when it has read it for it before. */
	extraction(fingerprint: string, topic: string): Extraction | undefined {
		const extracted = this.papers[fingerprint]?.extracted;
		return extracted && extracted.topic === topicKey(topic) ? extracted.data : undefined;
	}

	saveExtraction(fingerprint: string, topic: string, data: Extraction): void {
		const paper = this.papers[fingerprint];
		if (paper) {
			paper.extracted = { topic: topicKey(topic), data };
			this.changed('papers');
		}
	}

	// ---- The ranking's keyword weight, fitted on what was found relevant

	addJudgments(judgments: readonly Judgment[]): void {
		if (judgments.length) {
			this.judgments = [...this.judgments, ...judgments].slice(-JUDGMENTS_KEPT);
			this.fitted = undefined;
			this.changed('judgments');
		}
	}

	/** How much keywords count against meaning in the ranking: the default, until enough searches have been screened. */
	keywordWeight(): number {
		return this.fitted ??= fitKeywordWeight(this.judgments);
	}

	// ---- Vectors

	/** The paper's embedding, when it was made with this model. */
	vector(fingerprint: string, model: string): Float32Array | undefined {
		if (this.vectorFile.model !== model) {
			return undefined;
		}
		let vector = this.vectors.get(fingerprint);
		if (!vector && this.vectorFile.vectors[fingerprint]) {
			vector = decode(this.vectorFile.vectors[fingerprint]);
			this.vectors.set(fingerprint, vector);
		}
		return vector;
	}

	/** Keeps the embeddings. Those of another model are dropped: vectors of two models can't be compared. */
	saveVectors(model: string, vectors: ReadonlyMap<string, Float32Array>): void {
		if (this.vectorFile.model !== model) {
			this.vectorFile.model = model;
			this.vectorFile.vectors = {};
			this.vectors.clear();
		}
		for (const [fingerprint, vector] of vectors) {
			this.vectors.set(fingerprint, vector);
			this.vectorFile.vectors[fingerprint] = encode(vector);
		}
		this.changed('vectors');
	}

	/** The papers already known that are closest to the query's vector, as candidates from the source `atelier`. */
	recall(query: Float32Array, model: string, limit: number, atLeast: number): Paper[] {
		if (this.vectorFile.model !== model) {
			return [];
		}
		const scored: [number, string][] = [];
		for (const fingerprint of Object.keys(this.vectorFile.vectors)) {
			const vector = this.papers[fingerprint] && this.vector(fingerprint, model);
			if (vector) {
				const similarity = cosine(query, vector);
				if (similarity >= atLeast) {
					scored.push([similarity, fingerprint]);
				}
			}
		}
		scored.sort((a, b) => b[0] - a[0]);
		return scored.slice(0, limit).map(([, fingerprint]) => {
			const { extracted: _extracted, ...paper } = this.papers[fingerprint];
			return { ...paper, authors: [...paper.authors], sources: ['atelier'] };
		});
	}

	// ---- Sessions

	private stored(id: string): StoredSession | undefined {
		return this.sessions.find(session => session.id === id);
	}

	hasSession(id: string): boolean {
		return !!this.stored(id);
	}

	createSession(id: string, topic: string): void {
		this.sessions.unshift({ id, topic, summary: '', createdAt: Date.now(), queries: [] });
		this.changed('sessions');
		this._onDidChangeSessions.fire();
	}

	deleteSession(id: string): void {
		const index = this.sessions.findIndex(session => session.id === id);
		if (index >= 0) {
			this.sessions.splice(index, 1);
			this.changed('sessions');
			this._onDidChangeSessions.fire();
		}
	}

	/** How much is kept. */
	stats(): { sessions: number; papers: number } {
		return { sessions: this.sessions.length, papers: Object.keys(this.papers).length };
	}

	deleteAllSessions(): void {
		this.sessions.length = 0;
		this.changed('sessions');
		this._onDidChangeSessions.fire();
	}

	/** Forgets the Sessions, the papers, their embeddings and what the ranking learned. */
	deleteEverything(): void {
		this.sessions.length = 0;
		for (const fingerprint of Object.keys(this.papers)) {
			delete this.papers[fingerprint];
		}
		this.vectorFile.vectors = {};
		this.vectors.clear();
		this.judgments = [];
		this.fitted = undefined;
		for (const what of ['sessions', 'papers', 'vectors', 'judgments'] as const) {
			this.changed(what);
		}
		this._onDidChangeSessions.fire();
	}

	/** Adds a Query to its Session. A Session's summary is the opening of its first Synthesis. */
	addQuery(sessionId: string, query: StoredQuery): void {
		const session = this.stored(sessionId);
		if (!session) {
			return;
		}
		session.queries.push(query);
		if (!session.summary && query.papers.length) {
			const opening = query.synthesis.split('\n').map(line => line.replace(/[#*_>|`]/g, '').replace(/\[\d+\]/g, '').trim()).find(line => line.length > 40);
			session.summary = (opening ?? '').slice(0, 300);
		}
		this.changed('sessions');
		this._onDidChangeSessions.fire();
	}

	private cited(paper: QueryPaper, feedback?: Readonly<Record<string, 1 | -1>>): CitedPaper | undefined {
		const stored = this.papers[paper.fingerprint];
		if (!stored) {
			return undefined;
		}
		const { extracted: _extracted, ...rest } = stored;
		return { ...rest, studyType: classifyStudyType(stored.title, stored.abstract), score: paper.score, similarity: paper.similarity, extraction: paper.extraction, feedback: feedback?.[paper.fingerprint] };
	}

	private view(query: StoredQuery, feedback?: Readonly<Record<string, 1 | -1>>): Query {
		return { ...query, papers: query.papers.map(paper => this.cited(paper, feedback)).filter((paper): paper is CitedPaper => !!paper) };
	}

	private summary(session: StoredSession): SessionSummary {
		const papers = new Set(session.queries.flatMap(query => query.papers.map(paper => paper.fingerprint)));
		return { id: session.id, topic: session.topic, summary: session.summary, createdAt: session.createdAt, queryCount: session.queries.length, paperCount: papers.size };
	}

	/** The Sessions, newest first. */
	listSessions(): SessionSummary[] {
		return [...this.sessions].sort((a, b) => b.createdAt - a.createdAt).map(session => this.summary(session));
	}

	getSession(id: string): Session | undefined {
		const session = this.stored(id);
		return session && { ...this.summary(session), queries: session.queries.map(query => this.view(query, session.feedback)) };
	}

	getQuery(sessionId: string, queryId: string): Query | undefined {
		const query = this.stored(sessionId)?.queries.find(q => q.id === queryId);
		return query && this.view(query, this.stored(sessionId)?.feedback);
	}

	/** The Session's topic as its papers are read for: its latest search's. */
	topicOf(sessionId: string): string | undefined {
		const session = this.stored(sessionId);
		const search = session?.queries.findLast(query => query.route === 'search');
		return session && (search?.searchQuery ?? search?.prompt ?? session.topic);
	}

	paper(fingerprint: string): Paper | undefined {
		const stored = this.papers[fingerprint];
		if (!stored) {
			return undefined;
		}
		const { extracted: _extracted, ...paper } = stored;
		return paper;
	}

	feedback(sessionId: string): Readonly<Record<string, 1 | -1>> {
		return this.stored(sessionId)?.feedback ?? {};
	}

	setFeedback(sessionId: string, fingerprint: string, value: 1 | -1 | 0): void {
		const session = this.stored(sessionId);
		if (!session) {
			return;
		}
		session.feedback ??= {};
		if (value) {
			session.feedback[fingerprint] = value;
		} else {
			delete session.feedback[fingerprint];
		}
		this.changed('sessions');
		this._onDidChangeSessions.fire();
	}

	paperSummary(sessionId: string, fingerprint: string): string | undefined {
		return this.stored(sessionId)?.summaries?.[fingerprint];
	}

	savePaperSummary(sessionId: string, fingerprint: string, summary: string): void {
		const session = this.stored(sessionId);
		if (session) {
			(session.summaries ??= {})[fingerprint] = summary;
			this.changed('sessions');
		}
	}

	/** A Session drops the Query-less shell it was created as when its first search fails. */
	dropIfEmpty(id: string): void {
		if (this.stored(id)?.queries.length === 0) {
			this.deleteSession(id);
		}
	}
}
