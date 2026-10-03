/*---------------------------------------------------------------------------------------------
 *  Atelier: text and identifier helpers -- cleaning what the databases return, the Fingerprint a Paper is known by,
 *  and reading JSON out of what a model wrote. No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

/** Whitespace and newlines collapsed to single spaces. */
export function normalizeSpace(text: string | undefined | null): string {
	return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** The trimmed text, or undefined when there is none. */
export function cleanText(value: unknown): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const text = String(value).trim();
	return text || undefined;
}

/** An integer; failing that, a year found in the text ("2021 Jan-Feb"). */
export function safeInt(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? Math.trunc(value) : undefined;
	}
	const text = String(value).trim();
	if (/^-?\d+$/.test(text)) {
		return parseInt(text, 10);
	}
	const match = /\b(18|19|20)\d{2}\b/.exec(text);
	return match ? parseInt(match[0], 10) : undefined;
}

/** The text cut to `maxChars`, with an ellipsis when it was longer. */
export function truncate(text: string | undefined, maxChars: number): string {
	const clean = normalizeSpace(text);
	return clean.length <= maxChars ? clean : clean.slice(0, maxChars - 3).trimEnd() + '...';
}

export function normalizeDoi(doi: unknown): string | undefined {
	const text = cleanText(doi);
	if (!text) {
		return undefined;
	}
	return text.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '').trim().toLowerCase() || undefined;
}

export function normalizePmid(pmid: unknown): string | undefined {
	const text = cleanText(pmid);
	if (!text) {
		return undefined;
	}
	return text.replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//i, '').replace(/\/+$/, '').replace(/^pmid:/i, '').trim() || undefined;
}

export function normalizePmcid(pmcid: unknown): string | undefined {
	const text = cleanText(pmcid);
	if (!text) {
		return undefined;
	}
	const id = text.replace(/^https?:\/\/[^/]+\/(pmc\/)?articles\//i, '').replace(/\/+$/, '').toUpperCase().replace(/^PMCID:/, '').trim();
	if (!id) {
		return undefined;
	}
	return /^\d+$/.test(id) ? `PMC${id}` : id;
}

/** The global deduplication key of a Paper: the strongest identifier it has. */
export function makeFingerprint(ids: { doi?: string; pmid?: string; pmcid?: string; arxivId?: string; source: string; sourceId?: string }): string {
	const doi = normalizeDoi(ids.doi);
	const pmid = normalizePmid(ids.pmid);
	const pmcid = normalizePmcid(ids.pmcid);
	if (doi) {
		return `doi:${doi}`;
	}
	if (pmid) {
		return `pmid:${pmid}`;
	}
	if (pmcid) {
		return `pmcid:${pmcid}`;
	}
	if (ids.arxivId) {
		return `arxiv:${ids.arxivId.trim().toLowerCase()}`;
	}
	return `${ids.source}:${ids.sourceId ?? ''}`;
}

/** Letters and digits of the title, the first 60: the same paper from two databases with no identifier in common. */
export function titleKey(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
}

/** "Smith J, Doe A" as its authors. */
export function splitAuthors(authors: unknown): string[] {
	const text = cleanText(authors);
	return text ? text.replace(/\.$/, '').split(',').map(part => part.trim()).filter(Boolean) : [];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

/** Markup removed (`<i>`, `<sup>`...) and character entities decoded. */
export function stripTags(text: string | undefined): string {
	return normalizeSpace((text ?? '')
		.replace(/<[^>]+>/g, '')
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
			if (entity[0] === '#') {
				const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
			}
			return ENTITIES[entity.toLowerCase()] ?? whole;
		}));
}

/** The topic as papers' extractions are remembered under: the same question asked again reads nothing twice. */
export function topicKey(topic: string): string {
	return normalizeSpace(topic).toLowerCase();
}

/**
 * The JSON object in what a model wrote: reasoning blocks (`<think>`) and code fences removed, then the outermost
 * braces. Throws when there is none.
 */
export function parseModelJson(raw: string): Record<string, unknown> {
	let cleaned = stripThinking(raw);
	if (cleaned.startsWith('```')) {
		cleaned = cleaned.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
	}
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');
	if (start !== -1 && end > start) {
		try {
			const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				return value as Record<string, unknown>;
			}
		} catch {
			// reported below
		}
	}
	throw new Error(`The model's answer was not JSON: ${truncate(raw, 100)}`);
}

/** A model's answer without its reasoning blocks. */
export function stripThinking(text: string): string {
	return text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim();
}

/** `[1, 2]` written as `[1][2]`, the form citations are read in. */
export function splitCitations(markdown: string): string {
	return markdown.replace(/\[(\d+(?:\s*[,;]\s*\d+)+)\]/g, (_whole, list: string) => list.split(/[,;]/).map(n => `[${n.trim()}]`).join(''));
}

/**
 * A Synthesis's citations tidied: `[1, 2]` as `[1][2]`, and the numbers in a run of citations (`[4][1][2]`) in
 * ascending order without repeats. A paper's number is its place in the references, best evidence first, so a run in
 * ascending order names the strongest paper first.
 */
export function tidyCitations(markdown: string): string {
	return splitCitations(markdown).replace(/\[\d{1,3}\](?:[ \t]?\[\d{1,3}\])+/g, run =>
		[...new Set([...run.matchAll(/\d+/g)].map(m => Number(m[0])))].sort((a, b) => a - b).map(n => `[${n}]`).join(''));
}
