/*---------------------------------------------------------------------------------------------
 *  Atelier: what the webview and the extension host say to each other -- the host's methods, its events and the
 *  shapes they carry. Shared by both sides (types only, no imports of vscode or the DOM).
 *
 *  The words are Atelier's: a Session is a research thread anchored to a topic; a Query is one turn in it (a search or
 *  a follow-up) with its own Synthesis and cited Papers; a Paper is one deduplicated record, known by its Fingerprint.
 *--------------------------------------------------------------------------------------------*/

/** A chat model of DataSuite's (vscode.lm). */
export interface ModelInfo {
	readonly id: string;
	readonly name: string;
	readonly vendor: string;
	readonly family: string;
}

/**
 * Where a Paper was found: a database; `citations`, the citation trail of the best papers found (what they cite,
 * what cites them); or `atelier`, this machine's own store of papers read before.
 */
export type Source = 'pubmed' | 'europepmc' | 'openalex' | 'semanticscholar' | 'crossref' | 'core' | 'arxiv' | 'citations' | 'atelier';

/** One deduplicated academic record, whichever database it came from. */
export interface Paper {
	/** `doi:...`, else `pmid:...`, `pmcid:...`, `arxiv:...`, else `{source}:{id}`. */
	fingerprint: string;
	title: string;
	abstract: string;
	authors: string[];
	journal: string;
	year?: number;
	doi?: string;
	pmid?: string;
	pmcid?: string;
	pdfUrl?: string;
	fullTextUrl?: string;
	citationCount: number;
	/** The journal's citations per paper over two years (OpenAlex), about what an impact factor says. */
	journalImpact?: number;
	/** Every database that returned it. */
	sources: Source[];
}

/** What a paper says to a yes/no question. */
export type Stance = 'yes' | 'possibly' | 'mixed' | 'no';

/**
 * The Atelier Meter: how the cited papers answer a yes/no question, each weighted by its evidence tier and
 * citations. The four shares are percentages of the weight and add up to 100.
 */
export interface Meter {
	readonly yes: number;
	readonly possibly: number;
	readonly mixed: number;
	readonly no: number;
	/** The papers that take a stance. */
	readonly papers: number;
}

/** What the AI read out of a Paper for a topic. `-` where the paper doesn't say. */
export interface Extraction {
	/** The screening: only relevant papers are cited. */
	isRelevant: boolean;
	/** 0-100: how directly the paper answers the topic. */
	relevance: number;
	answer: string;
	population: string;
	methods: string;
	results: string;
	outcomes: string;
	sampleSize: string;
	studyCount: string;
	duration: string;
	country: string;
	/** For a yes/no question: what the paper says. Absent when the question isn't one, or the paper takes no side. */
	stance?: Stance;
	/** Whether the open-access full text was read, beside the abstract. */
	fullText?: boolean;
	/** Full text read: the abstract claims more than the paper shows, and why. */
	misleadingAbstract?: boolean;
	fidelity?: string;
}

/** A Paper as one Query cites it. */
export interface CitedPaper extends Paper {
	/** The evidence tier, from the title and abstract. */
	studyType: string;
	/** The ranking score the paper was read on (similarity to the topic, plus citations, recency and evidence tier). */
	score: number;
	/** The user's own judgment of the paper for this Session: it answers the question (1) or doesn't (-1). */
	feedback?: 1 | -1;
	/** The AI's first rating of the paper against the question, from its title and the opening of its abstract (0-100). */
	screened?: number;
	/** Cosine similarity to the topic (embeddings) -- absent when ranked by keywords. */
	similarity?: number;
	extraction?: Extraction;
}

export type Route = 'search' | 'chat';

/** How a search ranked its candidates: by meaning (DataSuite's embeddings) or, without them, by keywords. */
export type Ranking = 'embeddings' | 'keywords';

/** One turn of a Session, with its Synthesis and the Papers it cites (`[n]` is `papers[n - 1]`). */
export interface Query {
	readonly id: string;
	readonly prompt: string;
	readonly route: Route;
	/** The standalone search the prompt was turned into, when it differs from the prompt. */
	readonly searchQuery?: string;
	/** Markdown, citing papers as `[n]`. */
	readonly synthesis: string;
	readonly model: string;
	readonly createdAt: number;
	readonly papers: CitedPaper[];
	/** Search: the unique papers the databases returned, before screening. */
	readonly candidates?: number;
	/** Search: how many of the candidates (the highest ranked) the AI read and screened. */
	readonly read?: number;
	/** Search: candidates the first screening set aside as off-topic (they were not read). */
	readonly offTopic?: number;
	readonly ranking?: Ranking;
	/** Search, for a yes/no question with enough papers taking a stance. */
	readonly meter?: Meter;
}

export interface SessionSummary {
	readonly id: string;
	readonly topic: string;
	readonly summary: string;
	readonly createdAt: number;
	readonly queryCount: number;
	readonly paperCount: number;
}

export interface Session extends SessionSummary {
	readonly queries: Query[];
}

export type RunPhase = 'routing' | 'planning' | 'searching' | 'ranking' | 'screening' | 'widening' | 'reading' | 'synthesizing' | 'answering' | 'done' | 'failed' | 'stopped';

/** A paper found to answer the question, as the reading shows it while it goes on. */
export interface FoundPaper {
	readonly fingerprint: string;
	readonly title: string;
	readonly byline: string;
	readonly answer: string;
	readonly relevance: number;
}

/** What one database returned for a search. */
export interface SourceResult {
	readonly source: Source;
	/** Papers returned; absent while it is still being asked. */
	readonly count?: number;
	readonly error?: string;
}

/** A Query being worked on. The latest state replaces the one before. */
export interface Run {
	readonly sessionId: string;
	readonly prompt: string;
	readonly model: string;
	readonly phase: RunPhase;
	readonly route?: Route;
	readonly searchQuery?: string;
	readonly sources?: SourceResult[];
	readonly candidates?: number;
	readonly ranking?: Ranking;
	/** Screening: candidates rated so far, of how many; and those set aside as off-topic. */
	readonly screened?: number;
	readonly toScreen?: number;
	readonly offTopic?: number;
	/** Reading: the papers that answer the question being looked for. */
	readonly wanted?: number;
	/** Reading: papers read so far, of how many at most. */
	readonly read?: number;
	readonly toRead?: number;
	/** Papers that passed the screening so far. */
	readonly relevant?: number;
	/** Reading: the papers found to answer the question so far, as they come. */
	readonly found?: readonly FoundPaper[];
	/** A first look at the answer, written from the top abstracts while the papers are read; the Synthesis replaces it. */
	readonly preview?: string;
	/** What was done to widen the search beyond the databases' first answers. */
	readonly widened?: readonly string[];
	/** The Synthesis as it is written. */
	readonly text?: string;
	readonly error?: string;
}

export interface AppState {
	readonly models: ModelInfo[];
	/** The model last used, when it is still offered. */
	readonly model?: string;
	/** Whether papers can be ranked by meaning, and when not, why. */
	readonly embeddings: { readonly available: boolean; readonly message?: string };
	readonly version: string;
}

export type DownloadKind = 'pdf' | 'tables' | 'papers' | 'references' | 'ris' | 'bibtex';

/** The window's colours, for a PDF that looks as the screen does. */
export interface PdfTheme {
	readonly accent?: string;
	readonly badgeBackground?: string;
	readonly badgeForeground?: string;
}

/** The databases that take an API key. */
export type ApiKeyName = 'semanticScholar' | 'ncbi' | 'openAlex' | 'core';

export interface Settings {
	readonly maxResultsPerSource: number;
	readonly referencesWanted: number;
	readonly papersToRead: number;
	readonly readFullText: boolean;
	readonly contactEmail: string;
	/** The style references are downloaded in, and the PDF report cites in. */
	readonly citationStyle: CitationStyle;
	/**
	 * The model that screens and reads the papers (most of a search's requests): a fast one makes a search quicker, and
	 * keeping to one makes rankings alike from search to search. Empty: the model chosen for the question.
	 */
	readonly workModel: string;
	/** The databases a search asks. */
	readonly databases: readonly Source[];
	/** Whether a search follows the citations of the best papers it finds. */
	readonly followCitations: boolean;
	/** Whether a key is kept for each database (the keys themselves never leave the host). */
	readonly keys: Readonly<Record<ApiKeyName, boolean>>;
	/** What is kept on this machine. */
	readonly stored: { readonly sessions: number; readonly papers: number };
}

/** The settings the app changes. */
export type SettingName = 'maxResultsPerSource' | 'referencesWanted' | 'papersToRead' | 'readFullText' | 'contactEmail' | 'citationStyle' | 'workModel' | 'databases' | 'followCitations';

/**
 * How references are written and cited: by number -- in parentheses (Vancouver), raised above the line (AMA) or in
 * square brackets (IEEE) -- or by author and year (APA, Harvard).
 */
export type CitationStyle = 'vancouver' | 'ama' | 'apa' | 'harvard' | 'ieee';

/** How the PDF report is drawn: as the Query is shown when it is downloaded. */
export interface PdfOptions {
	readonly theme?: PdfTheme;
	/** The citation style of the report's citations and reference list (the host's setting, when not given). */
	readonly style?: CitationStyle;
	/** The references as cards (the list) or as the evidence table, whichever is selected on screen. */
	readonly view?: 'list' | 'table';
	/** The references shown, by their numbers, in the order shown: what the filters and the sorting leave. */
	readonly shown?: readonly number[];
}

/** A place in the app to open. */
export type Target = { readonly page: 'home' } | { readonly page: 'history' } | { readonly page: 'settings' } | { readonly page: 'session'; readonly id: string };

/** The host's methods, as the webview calls them. */
export interface AtelierHost {
	getState(): Promise<AppState>;
	listSessions(): Promise<SessionSummary[]>;
	getSession(id: string): Promise<Session | undefined>;
	/** Deletes a Session, once the user has confirmed. Resolves with whether it was deleted. */
	deleteSession(id: string): Promise<boolean>;
	/** Deletes every Session, or everything kept (Sessions, papers, embeddings), once the user has confirmed. */
	deleteData(what: 'sessions' | 'everything'): Promise<boolean>;
	getSettings(): Promise<Settings>;
	updateSetting<K extends SettingName>(name: K, value: Settings[K]): Promise<Settings>;
	/** Keeps a database's API key in DataSuite's secret storage; an empty key removes it. */
	setApiKey(name: ApiKeyName, key: string): Promise<Settings>;
	/** The Queries being worked on now. */
	listRuns(): Promise<Run[]>;
	/**
	 * Asks: a new Session's first search (no `sessionId`), or a follow-up in one. Resolves with the Session's id as
	 * soon as the work has started; its progress comes as `run` events and its result as `sessionsChanged`.
	 * `selected` are the fingerprints of papers the follow-up is about (it is then answered from those alone).
	 */
	ask(sessionId: string | undefined, prompt: string, model: string, selected?: string[]): Promise<string>;
	stop(sessionId: string): Promise<void>;
	/**
	 * The user's judgment of a paper for the Session: it answers the question (1), it doesn't (-1), or no judgment (0).
	 * The Session's later searches are screened with it, don't read what was judged out, and follow the citations of
	 * what was judged in.
	 */
	rate(sessionId: string, fingerprint: string, value: 1 | -1 | 0): Promise<void>;
	/**
	 * A Paper Summary: what one paper says about its Session's topic, written by the AI from its abstract (and full
	 * text, where open access). Made once per paper and Session, then kept.
	 */
	summarizePaper(sessionId: string, fingerprint: string, model: string): Promise<string>;
	/**
	 * Saves a Query to a file the user chooses: the report as it is on screen (`pdf`: its colours, and its references as they are selected -- list or table, filtered and sorted), the Synthesis's tables and the
	 * evidence table (`tables`), every paper with what was extracted from it (`papers`), or the references -- as a
	 * formatted list (`references`), or for a reference manager (`ris`, `bibtex`). Resolves with the file's path, or
	 * undefined when cancelled.
	 */
	download(sessionId: string, queryId: string, kind: DownloadKind, options?: PdfOptions): Promise<string | undefined>;
	/** Where the app was asked to open (from DataSuite's side bar or a command), once. */
	takeNavigation(): Promise<Target | undefined>;
	openLink(url: string): Promise<void>;
	copy(text: string): Promise<void>;
}

/** The host's events, by name, and their data. */
export interface AtelierEvents {
	run: Run;
	sessionsChanged: undefined;
	stateChanged: undefined;
	/** The app, already open, is asked to show a place. */
	navigate: Target;
}
