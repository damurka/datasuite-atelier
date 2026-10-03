/*---------------------------------------------------------------------------------------------
 *  Atelier: citation styles. A reference written as a style asks -- Vancouver and IEEE, which cite by number; APA and
 *  Harvard, which cite by author and year -- and the citation as it stands in the text. No imports of vscode.
 *
 *  The databases give authors, title, journal, year and DOI; volume, issue and pages are not kept, so a reference
 *  ends with its DOI (which finds the rest).
 *--------------------------------------------------------------------------------------------*/

import { CitationStyle } from '../shared/api';

export type { CitationStyle };

export const CITATION_STYLES: readonly { id: CitationStyle; label: string; byNumber: boolean }[] = [
	{ id: 'vancouver', label: 'Vancouver: (1-3, 5)', byNumber: true },
	{ id: 'ama', label: 'AMA: raised numbers', byNumber: true },
	{ id: 'ieee', label: 'IEEE: [1]-[3], [5]', byNumber: true },
	{ id: 'apa', label: 'APA 7th: (Lee et al., 2021)', byNumber: false },
	{ id: 'harvard', label: 'Harvard: (Lee et al., 2021)', byNumber: false }
];

/**
 * Numbers as a citation gathers them: in order, without repeats, three or more in a row as a range ("1-3"). `write`
 * writes a number or the ends of a range; `dash` and `comma` join them.
 */
export function numberRanges(numbers: readonly number[], dash: string, comma: string, write: (n: number) => string = String): string {
	const sorted = [...new Set(numbers)].sort((a, b) => a - b);
	const parts: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) {
			j++;
		}
		if (j - i >= 2) {
			parts.push(`${write(sorted[i])}${dash}${write(sorted[j])}`);
		} else {
			for (let k = i; k <= j; k++) {
				parts.push(write(sorted[k]));
			}
		}
		i = j + 1;
	}
	return parts.join(comma);
}

export function citationStyle(value: unknown): CitationStyle {
	return CITATION_STYLES.find(style => style.id === value)?.id ?? 'vancouver';
}

/** Whether the style cites by number (`[1]`) rather than by author and year. */
export const citesByNumber = (style: CitationStyle) => CITATION_STYLES.find(s => s.id === style)?.byNumber !== false;

/** What a reference is written from. */
export interface Citable {
	readonly title: string;
	readonly authors: readonly string[];
	readonly journal: string;
	readonly year?: number;
	readonly doi?: string;
	readonly pmid?: string;
	readonly fullTextUrl?: string;
	readonly pdfUrl?: string;
}

/** A piece of a reference: text, in italics where the style sets a journal so. */
export interface Segment {
	readonly text: string;
	readonly italics?: boolean;
}

interface Name {
	/** The family name; for a group ("WHO Study Group"), the whole name. */
	readonly family: string;
	/** The initials of the given names, without stops ("LA"). */
	readonly initials: string;
}

/**
 * An author as the databases write them -- "Lisa A Newman", "Newman LA", "Newman, Lisa A." -- as a family name and
 * initials. A group's name is kept whole.
 */
export function parseAuthor(author: string): Name {
	const name = author.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
	if (/\b(group|consortium|collaborat|committee|investigators|network|team|society|association|organi[sz]ation|initiative|project|program(me)?|council|ministry|department|university|institute)\b/i.test(name)) {
		return { family: name, initials: '' };
	}
	const initialsOf = (given: string) => given.split(/[\s.-]+/).filter(Boolean).map(part => part[0].toUpperCase()).join('');
	if (name.includes(',')) {
		const [family, ...given] = name.split(',');
		return { family: family.trim(), initials: initialsOf(given.join(' ')) };
	}
	const parts = name.split(' ');
	if (parts.length === 1) {
		return { family: name, initials: '' };
	}
	const last = parts[parts.length - 1];
	// "Newman LA": the family name first, then initials in capitals
	if (/^[A-Z]{1,3}$/.test(last) && parts.length >= 2 && !/^[A-Z]{1,3}$/.test(parts[0])) {
		return { family: parts.slice(0, -1).join(' '), initials: last };
	}
	// "Lisa A Newman", "Ludwig van Beethoven": the family name last, with the particles before it
	let start = parts.length - 1;
	while (start > 1 && /^(van|von|de|del|della|der|den|di|da|dos|du|la|le|bin|ibn|al|el|ter|ten)$/i.test(parts[start - 1])) {
		start--;
	}
	return { family: parts.slice(start).join(' '), initials: initialsOf(parts.slice(0, start).join(' ')) };
}

const dotted = (initials: string, gap = ' ') => initials.split('').map(letter => `${letter}.`).join(gap);
const sentence = (text: string) => text.replace(/[.\s]+$/, '');
const and = (names: readonly string[], word: string, serialComma: boolean) => names.length <= 1 ? names.join('')
	: names.length === 2 ? `${names[0]} ${word} ${names[1]}`
		: `${names.slice(0, -1).join(', ')}${serialComma ? ',' : ''} ${word} ${names[names.length - 1]}`;
const locator = (paper: Citable) => paper.doi ? `https://doi.org/${paper.doi}` : paper.fullTextUrl ?? paper.pdfUrl ?? (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : '');

/**
 * The reference in the style. `suffix` is the letter that tells apart two papers of the same authors and year in an
 * author-year style ("2020a").
 */
export function formatReference(paper: Citable, style: CitationStyle, suffix = ''): Segment[] {
	const names = paper.authors.map(parseAuthor);
	const title = sentence(paper.title);
	const journal = sentence(paper.journal);
	const year = paper.year ? `${paper.year}${suffix}` : `n.d.${suffix ? `-${suffix}` : ''}`;
	const where = locator(paper);
	const out: Segment[] = [];
	const add = (text: string, italics = false) => { if (text) { out.push(italics ? { text, italics } : { text }); } };
	switch (style) {
		case 'apa': {
			const written = names.map(n => n.initials ? `${n.family}, ${dotted(n.initials)}` : n.family);
			// up to twenty authors are all named; beyond that the first nineteen, an ellipsis and the last
			// (APA puts a comma before the ampersand even between two authors, their names being inverted)
			const authors = written.length > 20 ? `${written.slice(0, 19).join(', ')}, . . . ${written[written.length - 1]}`
				: written.length === 2 ? `${written[0]}, & ${written[1]}` : and(written, '&', true);
			add(`${authors ? `${sentence(authors)}. ` : ''}(${year}). ${title}.`);
			if (journal) { add(' '); add(journal, true); add('.'); }
			add(where ? ` ${where}` : '');
			break;
		}
		case 'harvard': {
			const written = names.map(n => n.initials ? `${n.family}, ${dotted(n.initials, '')}` : n.family);
			const authors = written.length > 3 ? `${written[0]} et al.` : and(written, 'and', false);
			add(`${authors ? `${authors} ` : ''}(${year}) '${title}'`);
			if (journal) { add(', '); add(journal, true); }
			add('.');
			add(paper.doi ? ` doi:${paper.doi}.` : where ? ` Available at: ${where}.` : '');
			break;
		}
		case 'ieee': {
			const written = names.map(n => n.initials ? `${dotted(n.initials)} ${n.family}` : n.family);
			const authors = written.length > 6 ? `${written[0]} et al.` : and(written, 'and', true);
			add(`${authors ? `${authors}, ` : ''}"${title},"`);
			if (journal) { add(' '); add(journal, true); add(','); }
			add(` ${paper.year ?? 'n.d.'}${paper.doi ? `, doi: ${paper.doi}` : ''}.`);
			add(!paper.doi && where ? ` [Online]. Available: ${where}` : '');
			break;
		}
		case 'ama': {
			// six authors are all named; of more, the first three and et al. The journal in italics.
			const written = names.map(n => n.initials ? `${n.family} ${n.initials}` : n.family);
			const authors = written.length > 6 ? `${written.slice(0, 3).join(', ')}, et al` : written.join(', ');
			add(`${authors ? `${sentence(authors)}. ` : ''}${title}.`);
			if (journal) { add(' '); add(journal, true); add('.'); }
			add(`${paper.year ? ` ${paper.year}.` : ''}${paper.doi ? ` doi:${paper.doi}` : where ? ` ${where}` : ''}`);
			break;
		}
		default: {
			// Vancouver: six authors, then et al.; initials without stops
			const written = names.map(n => n.initials ? `${n.family} ${n.initials}` : n.family);
			const authors = written.length > 6 ? `${written.slice(0, 6).join(', ')}, et al` : written.join(', ');
			add(`${authors ? `${sentence(authors)}. ` : ''}${title}.${journal ? ` ${journal}.` : ''}${paper.year ? ` ${paper.year}.` : ''}${paper.doi ? ` doi:${paper.doi}` : where ? ` ${where}` : ''}`);
		}
	}
	return out;
}

export const plainReference = (segments: readonly Segment[]) => segments.map(segment => segment.text).join('');

/** The authors as an author-year citation names them: one, two joined, or the first and "et al." */
function citedAuthors(paper: Citable, style: CitationStyle): string {
	const families = paper.authors.map(author => parseAuthor(author).family);
	if (!families.length) {
		// with no author, a style cites by the title's opening
		return `"${paper.title.split(/\s+/).slice(0, 4).join(' ')}..."`;
	}
	if (families.length === 1) {
		return families[0];
	}
	if (families.length === 2) {
		return `${families[0]} ${style === 'apa' ? '&' : 'and'} ${families[1]}`;
	}
	return `${families[0]} et al.`;
}

export interface ReferenceList {
	/** The references in the order the style lists them, each with the number the Synthesis knows it by. */
	readonly entries: readonly { readonly n: number; readonly segments: Segment[] }[];
	/**
	 * The citation in the text for the references of these numbers, as the style writes it: `(1-3, 5)`, `1-3,5` (to be
	 * raised), `[1]-[3], [5]`, or `(Lee et al., 2021; Omondi, 2019)`.
	 */
	cite(numbers: readonly number[]): string;
	/** Whether the style sets its citations above the line. */
	readonly superscript: boolean;
}

/**
 * The reference list of a style, and how its references are cited in the text. A style that cites by number lists
 * them by number; one that cites by author and year lists them by author, and tells apart those two alike by a letter.
 */
export function referenceList(papers: readonly Citable[], style: CitationStyle): ReferenceList {
	if (citesByNumber(style)) {
		return {
			entries: papers.map((paper, i) => ({ n: i + 1, segments: formatReference(paper, style) })),
			superscript: style === 'ama',
			cite: numbers => style === 'ama' ? numberRanges(numbers, '-', ',')
				: style === 'ieee' ? numberRanges(numbers, '\u2013', ', ', n => `[${n}]`)
					: `(${numberRanges(numbers, '\u2013', ', ')})`
		};
	}
	const labels = papers.map(paper => `${citedAuthors(paper, style)}\n${paper.year ?? 'n.d.'}`);
	const order = papers.map((_paper, i) => i).sort((a, b) =>
		plainReference(formatReference(papers[a], style)).localeCompare(plainReference(formatReference(papers[b], style)), undefined, { sensitivity: 'base' }) || a - b);
	// "2020a", "2020b" for the same authors and year, lettered in the list's order
	const suffix = new Array<string>(papers.length).fill('');
	const seen = new Map<string, number[]>();
	for (const index of order) {
		seen.set(labels[index], [...(seen.get(labels[index]) ?? []), index]);
	}
	for (const alike of seen.values()) {
		if (alike.length > 1) {
			alike.forEach((index, i) => { suffix[index] = String.fromCharCode(97 + (i % 26)); });
		}
	}
	const inText = (index: number) => {
		const paper = papers[index];
		return `${citedAuthors(paper, style)}, ${paper.year ?? 'n.d.'}${suffix[index]}`;
	};
	return {
		superscript: false,
		entries: order.map(index => ({ n: index + 1, segments: formatReference(papers[index], style, suffix[index]) })),
		cite: numbers => {
			const valid = [...new Set(numbers)].filter(n => n >= 1 && n <= papers.length);
			return valid.length ? `(${valid.map(n => inText(n - 1)).join('; ')})` : numbers.map(n => `[${n}]`).join('');
		}
	};
}
