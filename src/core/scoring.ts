/*---------------------------------------------------------------------------------------------
 *  Atelier: ranking the candidates of a search. Step 1 is how close a paper is to the topic -- cosine similarity of
 *  DataSuite's embeddings, or BM25 over the title and abstract when there are none. Step 2 adds what makes evidence
 *  worth reading first: citations, recency, the study design's evidence tier, and being found by several databases.
 *  No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

import { normalizeSpace } from './text';

/** Hierarchy of evidence. */
export const STUDY_TYPE_WEIGHTS: Readonly<Record<string, number>> = {
	'systematic review / meta-analysis': 5.0,
	'randomized controlled trial': 4.0,
	'cohort study': 3.0,
	'guideline / consensus': 3.0,
	'case-control study': 2.0,
	'cross-sectional study': 2.0,
	'qualitative study': 1.5,
	'mixed-methods study': 1.5,
	'observational study': 1.5,
	'case report / case series': 0.5,
	'unspecified': 0.0,
};

/** In order: the first design the title or abstract names. */
const STUDY_TYPE_PATTERNS: readonly [string, RegExp][] = [
	['systematic review / meta-analysis', /\b(systematic(ally)? review|meta-?analys[ie]s|scoping review|umbrella review|pooled analysis)\b/i],
	['randomized controlled trial', /\b(randomi[sz]ed|randomly (assigned|allocated)|\bRCT\b|controlled trial|cluster[- ]randomi[sz]ed)\b/i],
	['guideline / consensus', /\b(guidelines?|consensus statement|position (statement|paper)|recommendations? (of|from) the)\b/i],
	['mixed-methods study', /\bmixed[- ]methods?\b/i],
	['cohort study', /\b(cohort|longitudinal study|prospective(ly)? (study|followed)|retrospective (study|analysis|review)|follow-up study)\b/i],
	['case-control study', /\bcase[- ]control\b/i],
	['cross-sectional study', /\b(cross[- ]sectional|prevalence (study|survey)|household survey|demographic and health survey)\b/i],
	['qualitative study', /\b(qualitative|focus groups?|in-depth interviews?|semi-structured interviews?|thematic analysis|ethnograph)/i],
	['case report / case series', /\b(case report|case series|a case of)\b/i],
	['observational study', /\b(observational|registry|surveillance data|secondary analysis)\b/i],
];

/** The evidence tier, from the title first (where designs are announced) and then the abstract. */
export function classifyStudyType(title: string, abstract: string): string {
	for (const text of [title, abstract]) {
		if (!text) {
			continue;
		}
		for (const [type, pattern] of STUDY_TYPE_PATTERNS) {
			if (pattern.test(text)) {
				return type;
			}
		}
	}
	return 'unspecified';
}

/** A logarithmic bonus for citations, at most 3. */
export function citationBonus(citationCount: number | undefined): number {
	return citationCount && citationCount > 0 ? Math.min(3, Math.log1p(citationCount) * 0.5) : 0;
}

/** A linear bonus for recency: 0 for 2005 and before, 1 for this year. */
export function yearBonus(year: number | undefined, thisYear = new Date().getFullYear()): number {
	if (!year) {
		return 0;
	}
	return (Math.max(2005, Math.min(thisYear, year)) - 2005) / Math.max(1, thisYear - 2005);
}

/** A logarithmic bonus for the journal's citations per paper, at most 2 (about 1 for a journal at 5, 1.5 at 11). */
export function journalBonus(journalImpact: number | undefined): number {
	return journalImpact && journalImpact > 0 ? Math.min(2, Math.log1p(journalImpact) * 0.6) : 0;
}

/** Citations, recency, evidence tier, the journal, and one and a quarter for each further database the paper was found in. */
export function heuristicScore(paper: { citationCount: number; year?: number; sourceCount: number; studyType: string; journalImpact?: number }): number {
	const tier = STUDY_TYPE_WEIGHTS[paper.studyType] ?? 1.0;
	return citationBonus(paper.citationCount) + yearBonus(paper.year) + tier + journalBonus(paper.journalImpact) + Math.max(0, paper.sourceCount - 1) * 1.25;
}

/** Each value's place between the least (0) and the greatest (1) of them; all 1 when they are all the same. */
export function spread(values: readonly number[]): number[] {
	const min = Math.min(...values);
	const range = Math.max(...values) - min;
	return values.map(value => range > 0 ? (value - min) / range : 1);
}

/** How much of the hybrid closeness is the keywords' (the rest is the embeddings'), until there are judgments to fit it on. */
export const KEYWORD_WEIGHT = 0.3;

/** One screened paper: its meaning and keyword closeness (each spread over its search's candidates) and whether it was relevant. */
export type Judgment = readonly [meaning: number, words: number, relevant: 0 | 1];

/** Judgments needed, and of each kind, before the weight is fitted. */
const FIT_MIN = 150;
const FIT_MIN_EACH = 20;

/** How often a relevant paper scores above an irrelevant one (the area under the ROC curve). */
function auc(scores: readonly number[], relevant: readonly number[]): number {
	const order = scores.map((_score, i) => i).sort((a, b) => scores[a] - scores[b]);
	let rankSum = 0;
	let positives = 0;
	for (let i = 0; i < order.length;) {
		let j = i;
		while (j < order.length && scores[order[j]] === scores[order[i]]) {
			j++;
		}
		// tied scores share the middle of their ranks
		const rank = (i + j + 1) / 2;
		for (let k = i; k < j; k++) {
			if (relevant[order[k]]) {
				rankSum += rank;
				positives++;
			}
		}
		i = j;
	}
	const negatives = order.length - positives;
	return positives && negatives ? (rankSum - positives * (positives + 1) / 2) / (positives * negatives) : 0.5;
}

/**
 * The keyword weight that best told relevant papers from irrelevant ones in the searches so far: of 0, 0.1 ... 0.6,
 * the one under which a relevant paper most often outranks an irrelevant one. {@link KEYWORD_WEIGHT} until there are
 * enough judgments of both kinds, and when no weight does better than it.
 */
export function fitKeywordWeight(judgments: readonly Judgment[]): number {
	const positives = judgments.reduce((n, j) => n + j[2], 0);
	if (judgments.length < FIT_MIN || positives < FIT_MIN_EACH || judgments.length - positives < FIT_MIN_EACH) {
		return KEYWORD_WEIGHT;
	}
	const relevant = judgments.map(j => j[2]);
	const quality = (weight: number) => auc(judgments.map(j => j[0] * (1 - weight) + j[1] * weight), relevant);
	let best = KEYWORD_WEIGHT;
	let bestQuality = quality(KEYWORD_WEIGHT);
	for (const weight of [0, 0.1, 0.2, 0.4, 0.5, 0.6]) {
		const q = quality(weight);
		if (q > bestQuality + 0.002) {
			best = weight;
			bestQuality = q;
		}
	}
	return best;
}

/**
 * Closeness to the topic by meaning and by words together: embeddings find the paper that says it differently,
 * keywords the one that names the exact drug or place. Each is spread over the candidates (embedding similarities sit
 * in a narrow band; spread, their differences count) and the two are blended.
 */
export function hybridCloseness(similarity: readonly number[], keyword: readonly number[], keywordWeight = KEYWORD_WEIGHT): number[] {
	if (!similarity.length) {
		return [];
	}
	const meaning = spread(similarity);
	const words = keyword.some(score => score > 0) ? spread(keyword) : undefined;
	return meaning.map((value, i) => words ? value * (1 - keywordWeight) + words[i] * keywordWeight : value);
}

/** The most a paper's quality (citations, recency, design, journal) adds to its relevance. */
export const QUALITY_CAP = 10;
/** A paper the first screening rates below this is set aside as off-topic, and not read. */
export const OFF_TOPIC = 20;
/** A first-screening rating from which a paper counts as relevant, when the weights are fitted. */
export const SCREENED_RELEVANT = 50;

/**
 * The ranking score, 0 to 110. Relevance comes first: the AI's first screening of the paper against the question
 * (0-100, three quarters of it) with closeness to the topic (a quarter, which orders papers the screening rates alike);
 * for a paper not screened, closeness alone. Quality then adds at most {@link QUALITY_CAP}: it settles which of two
 * papers that answer the question equally is read first, and never lifts an off-topic paper over an on-topic one.
 */
export function rankScores(closeness: readonly number[], screened: readonly (number | undefined)[], heuristics: readonly number[]): number[] {
	const max = Math.max(0, ...closeness) || 1;
	return closeness.map((c, i) => {
		const close = Math.max(0, c) / max;
		const rating = screened[i];
		const relevance = rating === undefined ? close * 100 : Math.max(0, Math.min(100, rating)) * 0.75 + close * 25;
		return Math.round((relevance + Math.min(QUALITY_CAP, heuristics[i] * 0.7)) * 100) / 100;
	});
}

/** The vector at length 1 (a zero vector stays zero). */
export function normalize(values: ArrayLike<number>): Float32Array {
	const out = Float32Array.from(values);
	let sum = 0;
	for (const v of out) {
		sum += v * v;
	}
	const length = Math.sqrt(sum);
	if (length > 0) {
		for (let i = 0; i < out.length; i++) {
			out[i] /= length;
		}
	}
	return out;
}

/** Cosine similarity of two unit vectors. */
export function cosine(a: Float32Array, b: Float32Array): number {
	const n = Math.min(a.length, b.length);
	let dot = 0;
	for (let i = 0; i < n; i++) {
		dot += a[i] * b[i];
	}
	return dot;
}

/** What is embedded for a paper: its title and abstract, within what the embeddings model reads. */
export function embeddingText(paper: { title: string; abstract: string }): string {
	return normalizeSpace(`${paper.title}\n${paper.abstract}`).slice(0, 8000) || '-';
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'how', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'to', 'was', 'were', 'what', 'which', 'with', 'among', 'between', 'into', 'than', 'there', 'these', 'this', 'those', 'we', 'can', 'has', 'have']);

function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/** BM25 of each document for the query: the ranking when there are no embeddings. */
export function keywordScores(query: string, documents: readonly string[]): number[] {
	const terms = [...new Set(tokens(query))];
	const docs = documents.map(tokens);
	const average = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, docs.length) || 1;
	const k1 = 1.5;
	const b = 0.75;
	const scores = new Array<number>(docs.length).fill(0);
	for (const term of terms) {
		const counts = docs.map(d => d.reduce((n, t) => n + (t === term ? 1 : 0), 0));
		const containing = counts.filter(c => c > 0).length;
		if (!containing) {
			continue;
		}
		const idf = Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5));
		counts.forEach((count, i) => {
			if (count) {
				scores[i] += idf * (count * (k1 + 1)) / (count + k1 * (1 - b + b * docs[i].length / average));
			}
		});
	}
	return scores;
}

export type MeterStance = 'yes' | 'possibly' | 'mixed' | 'no';

/** Fewer papers taking a stance than this say too little for a meter. */
export const METER_MIN_PAPERS = 3;

/**
 * The Atelier Meter: the share of the evidence behind each answer to a yes/no question. A paper counts for its
 * evidence tier (at least 1) plus its citation bonus, so a meta-analysis outweighs a case report. The shares are whole
 * percentages adding up to 100; undefined when too few papers take a stance.
 */
export function computeMeter(papers: readonly { stance?: MeterStance; studyType: string; citationCount: number }[]): { yes: number; possibly: number; mixed: number; no: number; papers: number } | undefined {
	const order: MeterStance[] = ['yes', 'possibly', 'mixed', 'no'];
	const weights: Record<MeterStance, number> = { yes: 0, possibly: 0, mixed: 0, no: 0 };
	let count = 0;
	for (const paper of papers) {
		if (paper.stance && order.includes(paper.stance)) {
			weights[paper.stance] += Math.max(1, STUDY_TYPE_WEIGHTS[paper.studyType] ?? 1) + citationBonus(paper.citationCount);
			count++;
		}
	}
	const total = order.reduce((sum, stance) => sum + weights[stance], 0);
	if (count < METER_MIN_PAPERS || total <= 0) {
		return undefined;
	}
	// largest remainders, so the rounded shares still add up to 100
	const exact = order.map(stance => weights[stance] / total * 100);
	const shares = exact.map(Math.floor);
	const byRemainder = exact.map((value, i) => [value - shares[i], i]).sort((a, b) => b[0] - a[0]);
	for (let i = 0, left = 100 - shares.reduce((sum, share) => sum + share, 0); i < left; i++) {
		shares[byRemainder[i % 4][1]]++;
	}
	return { yes: shares[0], possibly: shares[1], mixed: shares[2], no: shares[3], papers: count };
}

/**
 * How strong a paper is as evidence, whatever the question, at most {@link QUALITY_CAP}: its study design first -- a
 * meta-analysis 7, a trial 5.6, a cohort 4.2, down to a case report 0.7 -- then how cited it is (to 1.8) and its
 * journal (to 1.2). How recent it is and how many databases returned it say how easily it is found, not how strong it
 * is: they count in the search's ranking, not here.
 */
export function evidenceQuality(paper: { studyType: string; citationCount: number; journalImpact?: number }): number {
	const tier = STUDY_TYPE_WEIGHTS[paper.studyType] ?? 1.0;
	return Math.min(QUALITY_CAP, tier * 1.4 + citationBonus(paper.citationCount) * 0.6 + journalBonus(paper.journalImpact) * 0.6);
}

/**
 * How good a paper is as evidence for the question, once the AI has read it: how directly it answers (0-100, the
 * reading's own rating) plus its {@link evidenceQuality}. The references are listed by it, best first: of two papers
 * that answer equally, the meta-analysis comes before the cross-sectional study, however cited that is; a strong
 * study that barely answers never comes before one that does.
 */
export function evidenceScore(relevance: number, quality: number): number {
	return Math.round((Math.max(0, Math.min(100, relevance)) + Math.min(QUALITY_CAP, Math.max(0, quality))) * 100) / 100;
}
