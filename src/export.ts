/*---------------------------------------------------------------------------------------------
 *  Atelier: a Query taken out of the app -- as a PDF report (the question, the Atelier Meter, the Synthesis, the
 *  references), its tables as CSV, and its references for a reference manager (RIS, BibTeX) or as a formatted list.
 *  No imports of vscode.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { marked, Token, Tokens } from 'marked';
import * as path from 'path';
import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';
import { CitationStyle, citesByNumber, plainReference, referenceList, ReferenceList } from './core/cite';
import { CitedPaper, PdfOptions, Query } from './shared/api';

const known = (value: string | undefined): value is string => !!value && value !== '-';
const link = (paper: CitedPaper) => paper.doi ? `https://doi.org/${paper.doi}` : paper.fullTextUrl ?? paper.pdfUrl ?? (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : undefined);

// ---- References

/**
 * The references as a list in the style: numbered as the Synthesis cites them for a style that cites by number, by
 * author for one that cites by author and year.
 */
export function referencesText(query: Query, style: CitationStyle = 'vancouver'): string {
	const byNumber = citesByNumber(style);
	const numbered = (n: number) => style === 'ieee' ? `[${n}] ` : `${n}. `;
	return referenceList(query.papers, style).entries.map(entry => `${byNumber ? numbered(entry.n) : ''}${plainReference(entry.segments)}`).join(byNumber ? '\r\n' : '\r\n\r\n') + '\r\n';
}

/** The references for a reference manager (Zotero, EndNote, Mendeley), in RIS. */
export function referencesRis(query: Query): string {
	const line = (tag: string, value: string | number | undefined) => value === undefined || value === '' ? [] : [`${tag}  - ${String(value).replace(/\s+/g, ' ').trim()}`];
	return query.papers.map(paper => [
		'TY  - JOUR',
		...line('TI', paper.title),
		...paper.authors.flatMap(author => line('AU', author)),
		...line('JO', paper.journal),
		...line('PY', paper.year),
		...line('DO', paper.doi),
		...line('AN', paper.pmid),
		...line('UR', link(paper)),
		...line('L1', paper.pdfUrl),
		...line('AB', paper.abstract),
		'ER  - '
	].join('\r\n')).join('\r\n\r\n') + '\r\n';
}

/** The references in BibTeX. A key is the first author's last name, the year and the reference's number. */
export function referencesBibtex(query: Query): string {
	const escape = (text: string) => text.replace(/\s+/g, ' ').trim().replace(/([&%$#_{}])/g, '\\$1');
	return query.papers.map((paper, i) => {
		const name = (paper.authors[0] ?? 'anon').split(/\s+/).pop()!.toLowerCase().replace(/[^a-z]/g, '') || 'anon';
		const fields: [string, string | number | undefined][] = [
			['title', paper.title && `{${escape(paper.title)}}`],
			['author', paper.authors.map(escape).join(' and ')],
			['journal', paper.journal && escape(paper.journal)],
			['year', paper.year],
			['doi', paper.doi],
			['pmid', paper.pmid],
			['url', link(paper)]
		];
		return `@article{${name}${paper.year ?? ''}_${i + 1},\n${fields.filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => `  ${key} = {${value}}`).join(',\n')}\n}`;
	}).join('\n\n') + '\n';
}

// ---- Tables

const csvCell = (value: unknown) => {
	const text = value === undefined || value === null ? '' : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csvRows = (rows: readonly (readonly unknown[])[]) => rows.map(row => row.map(csvCell).join(',')).join('\r\n');
/** Markdown's marks taken off a cell: what a spreadsheet should show. */
const plain = (text: string) => text.replace(/\*\*|__|`/g, '').replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|[.,;:]|$)/g, '$1$2').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();

export interface SynthesisTable {
	/** The heading the table stands under. */
	readonly title: string;
	readonly header: string[];
	readonly rows: string[][];
}

/** The tables of a Synthesis, each with the heading it stands under. */
export function synthesisTables(markdown: string): SynthesisTable[] {
	const tables: SynthesisTable[] = [];
	let title = '';
	for (const token of marked.lexer(markdown, { gfm: true })) {
		if (token.type === 'heading') {
			title = plain((token as Tokens.Heading).text);
		} else if (token.type === 'table') {
			const table = token as Tokens.Table;
			tables.push({ title, header: table.header.map(cell => plain(cell.text)), rows: table.rows.map(row => row.map(cell => plain(cell.text))) });
		}
	}
	return tables;
}

/** The evidence table: each paper a row, with what was extracted from it. */
function evidenceRows(query: Query): unknown[][] {
	return [
		['#', 'Paper', 'Authors', 'Year', 'Design', 'Methods', 'Says', 'Population', 'Sample size', 'Outcomes', 'Results', 'Location', 'Read from', 'Link'],
		...query.papers.map((paper, i) => {
			const e = paper.extraction;
			const cell = (value: string | undefined) => known(value) ? value : '';
			return [i + 1, paper.title, paper.authors.join('; '), paper.year, paper.studyType === 'unspecified' ? '' : paper.studyType, cell(e?.methods), e?.stance, cell(e?.population), cell(e?.sampleSize), cell(e?.outcomes), cell(e?.results), cell(e?.country), e ? (e.fullText ? 'Full text' : 'Abstract') : '', link(paper)];
		})
	];
}

/** The Synthesis's tables and the evidence table in one CSV, each under its title. `[n]` is reference n. */
export function tablesCsv(query: Query): string {
	const blocks = synthesisTables(query.synthesis).map(table => csvRows([[table.title || 'Table'], table.header, ...table.rows]));
	if (query.papers.length) {
		blocks.push(csvRows([['Evidence table'], ...evidenceRows(query)]));
	}
	// the BOM tells Excel the file is UTF-8
	return '﻿' + blocks.join('\r\n\r\n') + '\r\n';
}

// ---- The PDF report: the Query as a document -- the window's font and colours, its paragraphs justified, its
//      citations written as the citation style writes them, and its references written out in that style

type Pdf = Record<string, unknown>;

const INK = '#1f2328';
const MUTED = '#6a737d';
const RULE = '#d8dee4';
const SURFACE = '#f4f5f7';
const WIDTH = 515;
const STANCE_COLORS: Record<string, string> = { yes: '#1a9a5c', possibly: '#7fb93f', mixed: '#d99a1c', no: '#d6453d' };
const hex = (color: string | undefined, fallback: string) => color && /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim() : fallback;

interface Look {
	/** The citation of these references, as the style writes it in the text. */
	readonly cite: (numbers: number[]) => string;
	/** Whether the style sets its citations above the line. */
	readonly superscript: boolean;
	readonly accent: string;
}

/**
 * Inline Markdown as pdfmake text runs. A run of `[n]` citations is one citation, written as the style writes it:
 * "(1-3, 5)", "[1]-[3], [5]", raised numbers, or "(Lee et al., 2021; Omondi, 2019)".
 */
function inline(tokens: readonly Token[] | undefined, look: Look, style: Pdf = {}, upper = false): Pdf[] {
	const runs: Pdf[] = [];
	const text = (value: string) => {
		const parts = value.split(/((?:\[\d{1,3}\])+)/g);
		// Raised citations stand against the word they follow, after its full stop or comma ("uptake.1-3"). Citations
		// that are all a text holds -- a table's Sources cell -- are written on the line: there is no word to raise them from.
		const raised = look.superscript && parts.some((part, i) => i % 2 === 0 && part.trim());
		for (let i = 0; i < parts.length; i++) {
			let part = parts[i];
			if (i % 2) {
				const numbers = [...part.matchAll(/\d+/g)].map(match => Number(match[0]));
				if (raised) {
					const stop = /^[.,;:]/.exec(parts[i + 1] ?? '')?.[0];
					if (stop) {
						runs.push({ ...style, text: stop });
						parts[i + 1] = parts[i + 1].slice(1);
					}
					runs.push({ text: look.cite(numbers), sup: true });
				} else {
					runs.push({ text: look.cite(numbers) });
				}
			} else {
				if (raised && parts[i + 1]) {
					part = part.replace(/\s+$/, '');
				}
				if (part) {
					runs.push({ ...style, text: upper ? part.toUpperCase() : part });
				}
			}
		}
	};
	for (const token of tokens ?? []) {
		const t = token as Tokens.Generic;
		switch (token.type) {
			case 'strong': runs.push(...inline(t.tokens, look, { ...style, bold: true }, upper)); break;
			case 'em': runs.push(...inline(t.tokens, look, { ...style, italics: true }, upper)); break;
			case 'del': runs.push(...inline(t.tokens, look, { ...style, decoration: 'lineThrough' }, upper)); break;
			case 'link': runs.push(...inline(t.tokens, look, { ...style, link: String(t.href ?? ''), color: look.accent }, upper)); break;
			case 'br': runs.push({ text: '\n' }); break;
			case 'text': if (t.tokens?.length) { runs.push(...inline(t.tokens, look, style, upper)); } else { text(String(t.text ?? '')); } break;
			case 'codespan': case 'escape': case 'image': text(String(t.text ?? '')); break;
			default: text(String(t.raw ?? ''));
		}
	}
	return runs;
}

/** Block Markdown as pdfmake content, styled as the Synthesis is on screen. */
function blocks(tokens: readonly Token[], look: Look): Pdf[] {
	const out: Pdf[] = [];
	for (const token of tokens) {
		const t = token as Tokens.Generic;
		switch (token.type) {
			case 'space': break;
			case 'hr': out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: WIDTH, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 6, 0, 6] }); break;
			// on screen a Synthesis's headings are small capitals, spaced out, in the muted colour
			case 'heading': out.push({ text: inline(t.tokens, look, {}, true), style: 'eyebrow' }); break;
			case 'paragraph': case 'text': out.push({ text: t.tokens?.length ? inline(t.tokens, look) : String(t.text ?? ''), style: 'p' }); break;
			case 'blockquote': out.push({ stack: blocks(t.tokens ?? [], look), margin: [12, 0, 0, 0], color: MUTED }); break;
			case 'code': out.push({ text: String(t.text ?? ''), fontSize: 8.5, margin: [0, 2, 0, 8], preserveLeadingSpaces: true }); break;
			case 'list': {
				const list = token as Tokens.List;
				const items = list.items.map(item => item.tokens.length === 1 && item.tokens[0].type === 'text'
					? { text: inline((item.tokens[0] as Tokens.Text).tokens ?? [item.tokens[0]], look), alignment: 'justify', margin: [0, 0, 0, 4] }
					: { stack: blocks(item.tokens, look) });
				out.push({ [list.ordered ? 'ol' : 'ul']: items, margin: [0, 0, 0, 6] });
				break;
			}
			case 'table': {
				const table = token as Tokens.Table;
				const width = table.header.length;
				// every row as wide as the header, or the table can't be drawn
				const row = (cells: readonly Tokens.TableCell[], header: boolean) => Array.from({ length: width }, (_x, i) => header
					? { text: cells[i] ? inline(cells[i].tokens, look, { bold: true, color: look.accent, fontSize: 7.5, characterSpacing: 0.8 }, true) : '', fillColor: SURFACE, margin: [0, 4, 0, 4] }
					: { text: cells[i] ? inline(cells[i].tokens, look, i === 0 ? { bold: true } : {}) : '', margin: [0, 4, 0, 4] });
				out.push({
					table: { headerRows: 1, dontBreakRows: true, widths: Array.from({ length: width }, (_x, i) => width > 2 && (i === 0 || i === width - 1) ? 'auto' : '*'), body: [row(table.header, true), ...table.rows.map(cells => row(cells, false))] },
					layout: {
						hLineWidth: () => 0.6, hLineColor: () => RULE,
						vLineWidth: (i: number) => i === 0 || i === width ? 0.6 : 0, vLineColor: () => RULE,
						paddingLeft: () => 8, paddingRight: () => 8
					},
					fontSize: 9, margin: [0, 2, 0, 12]
				});
				break;
			}
			default: out.push({ text: String(t.raw ?? ''), style: 'p' });
		}
	}
	return out;
}

/** The evidence table: a paper a row, with its design, population, sample, outcomes and place, cited as the style cites. */
function evidenceTable(papers: readonly { paper: CitedPaper; n: number }[], look: Look, byNumber: boolean): Pdf {
	const stances = papers.some(({ paper }) => paper.extraction?.stance);
	const cell = (value: string | undefined) => known(value) ? value : '-';
	const head = [...(byNumber ? ['Ref.'] : []), 'Paper', ...(stances ? ['Says'] : []), 'Design', 'Population', 'N', 'Outcomes', 'Location']
		.map(text => ({ text: text.toUpperCase(), bold: true, color: look.accent, fontSize: 7, characterSpacing: 0.7, fillColor: SURFACE, margin: [0, 3, 0, 3] }));
	const rows = papers.map(({ paper, n }) => {
		const e = paper.extraction;
		const author = paper.authors.length ? `${paper.authors[0]}${paper.authors.length > 1 ? ' et al.' : ''}` : 'Unknown authors';
		return [
			...(byNumber ? [{ text: String(n), color: MUTED }] : []),
			{ stack: [{ text: paper.title, bold: true }, { text: `${author}${paper.year ? ` · ${paper.year}` : ''} · read from ${e?.fullText ? 'full text' : 'abstract'}`, color: MUTED, fontSize: 7 }] },
			...(stances ? [e?.stance ? { text: ` ${e.stance.charAt(0).toUpperCase() + e.stance.slice(1)} `, background: STANCE_COLORS[e.stance] ?? MUTED, color: '#ffffff', fontSize: 7 } : '-'] : []),
			paper.studyType === 'unspecified' ? cell(e?.methods) : paper.studyType,
			cell(e?.population), cell(e?.sampleSize), cell(e?.outcomes), cell(e?.country)
		].map(value => typeof value === 'string' ? { text: value, margin: [0, 3, 0, 3] } : { ...value, margin: [0, 3, 0, 3] });
	});
	const widths = [...(byNumber ? ['auto'] : []), '*', ...(stances ? ['auto'] : []), 62, 72, 34, 72, 56];
	return {
		table: { headerRows: 1, dontBreakRows: true, widths, body: [head, ...rows] },
		layout: {
			hLineWidth: () => 0.6, hLineColor: () => RULE,
			vLineWidth: (i: number) => i === 0 || i === widths.length ? 0.6 : 0, vLineColor: () => RULE,
			paddingLeft: () => 5, paddingRight: () => 5
		},
		fontSize: 8, lineHeight: 1.2, margin: [0, 4, 0, 0]
	};
}

/** The report's definition for pdfmake (what {@link queryPdf} draws). */
export function pdfDefinition(query: Query, topic: string, options: PdfOptions = {}, font = 'Roboto'): Pdf {
	const style = options.style ?? 'vancouver';
	const byNumber = citesByNumber(style);
	const references: ReferenceList = referenceList(query.papers, style);
	const look: Look = { cite: numbers => references.cite(numbers), superscript: references.superscript, accent: hex(options.theme?.accent, '#1a4f8b') };
	const search = query.route === 'search';
	const count = query.papers.length;
	const facts = [
		query.model,
		search ? `${count} reference${count === 1 ? '' : 's'}${query.read ? ` · ${query.read} read of ${query.candidates} found` : ''}` : `${count} context paper${count === 1 ? '' : 's'}`,
		search && query.ranking ? `ranked by ${query.ranking === 'embeddings' ? 'meaning and keywords' : 'keywords'}` : '',
		new Date(query.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
	].filter(Boolean).join('  ·  ').toUpperCase();
	const content: Pdf[] = [
		{ text: query.prompt, style: 'h1' },
		{ text: facts, style: 'meta' },
		...(query.searchQuery ? [{ text: `Searched for: ${query.searchQuery}`, color: MUTED, fontSize: 9, margin: [0, 0, 0, 2] }] : []),
		...(query.prompt !== topic ? [{ text: `In the session: ${topic}`, color: MUTED, fontSize: 9, margin: [0, 0, 0, 2] }] : [])
	];
	if (query.meter) {
		const meter = query.meter;
		const shares: [string, number, string][] = [['Yes', meter.yes, STANCE_COLORS.yes], ['Possibly', meter.possibly, STANCE_COLORS.possibly], ['Mixed', meter.mixed, STANCE_COLORS.mixed], ['No', meter.no, STANCE_COLORS.no]];
		const inner = WIDTH - 28;
		let x = 0;
		content.push({
			table: {
				widths: ['*'],
				body: [[{
					stack: [
						{ columns: [{ text: 'Atelier Meter', bold: true, fontSize: 11 }, { text: `${meter.papers} of ${count} papers take a side · weighted by study design and citations`, color: MUTED, fontSize: 8, alignment: 'right', margin: [0, 2, 0, 0] }] },
						{ canvas: shares.filter(([, share]) => share > 0).map(([, share, color]) => { const w = Math.max(0, inner * share / 100 - 1.5); const rect = { type: 'rect', x, y: 0, w, h: 8, r: 2, color }; x += w + 1.5; return rect; }), margin: [0, 8, 0, 6] },
						{ text: shares.flatMap(([name, share, color]) => [{ text: '● ', color }, { text: `${name} ` }, { text: `${share}%`, bold: true }, { text: '        ' }]), fontSize: 9 }
					],
					margin: [6, 6, 6, 6], fillColor: SURFACE
				}]]
			},
			layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => RULE, vLineColor: () => RULE },
			margin: [0, 10, 0, 4]
		});
	}
	content.push({ text: search ? 'Synthesis Summary' : 'Answer', style: 'h2' }, ...blocks(marked.lexer(query.synthesis, { gfm: true }), look));

	// the evidence table, when the table is what is selected on screen: the papers the filters leave, in the order
	// they are sorted
	const numbered = query.papers.map((paper, i) => ({ paper, n: i + 1 }));
	const listed = options.shown ? options.shown.filter(n => Number.isInteger(n) && n >= 1 && n <= count).map(n => numbered[n - 1]) : numbered;
	if (options.view === 'table' && listed.length) {
		content.push(
			{
				stack: [
					{ text: 'Evidence table', style: 'h2', margin: [0, 18, 0, 0] },
					{ text: `${listed.length < count ? `${listed.length} of the ${count} references, as filtered. ` : ''}What each paper studied, read from its full text where it is open access.`, color: MUTED, fontSize: 8.5, margin: [0, 2, 0, 4] }
				],
				unbreakable: true
			},
			evidenceTable(listed, look, byNumber)
		);
	}

	// the references, written out as the citation style writes them: every paper of the Query, by number or by author
	if (count) {
		const written = (segments: readonly { text: string; italics?: boolean }[]) => segments.map(segment => segment.italics ? { text: segment.text, italics: true } : { text: segment.text });
		const entries = references.entries.map(entry => byNumber
			? { columns: [{ text: style === 'ieee' ? `[${entry.n}]` : `${entry.n}.`, width: style === 'ieee' ? 26 : 22, alignment: 'right' }, { text: written(entry.segments), width: '*', alignment: 'left' }], columnGap: 6, margin: [0, 0, 0, 6], unbreakable: true }
			// a hanging indent, as author-year lists are set: the first line out, the rest in
			: { stack: [{ text: written(entry.segments), margin: [18, 0, 0, 6], leadingIndent: -18, alignment: 'left' }], unbreakable: true });
		content.push(
			// the heading stays with the first reference: never alone at the foot of a page
			{ stack: [{ text: 'References', style: 'h2', margin: [0, 18, 0, 8] }, entries[0]], unbreakable: true },
			...entries.slice(1)
		);
	}
	return {
		pageSize: 'A4',
		pageMargins: [40, 44, 40, 48],
		info: { title: query.prompt, subject: topic, creator: 'Atelier (DataSuite)' },
		defaultStyle: { font, fontSize: 10, lineHeight: 1.35, color: INK },
		styles: {
			h1: { fontSize: 19, bold: true, lineHeight: 1.15, margin: [0, 0, 0, 6] },
			h2: { fontSize: 15, bold: true, margin: [0, 16, 0, 8] },
			meta: { fontSize: 7.5, bold: true, color: MUTED, characterSpacing: 0.9, margin: [0, 0, 0, 6] },
			eyebrow: { fontSize: 8, bold: true, color: MUTED, characterSpacing: 1.3, margin: [0, 10, 0, 6] },
			p: { alignment: 'justify', margin: [0, 0, 0, 8] }
		},
		footer: (page: number, pages: number) => ({ text: `Atelier  ·  ${page} of ${pages}`, alignment: 'center', color: MUTED, fontSize: 8, margin: [0, 16, 0, 0] }),
		content
	};
}

/** The fonts the report can be set in, by family: the bundled Roboto, and the window's own where its files are found. */
let fonts: string | undefined;

/**
 * Registers the fonts once and answers the family to use: Segoe UI, the font of DataSuite's windows on Windows, read
 * from the system's fonts so the PDF looks as the screen does; Roboto (bundled) anywhere it isn't found.
 */
function reportFont(): string {
	if (fonts) {
		return fonts;
	}
	pdfMake.addVirtualFileSystem(pdfFonts);
	fonts = 'Roboto';
	try {
		const dir = path.join(process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows', 'Fonts');
		const files = { normal: 'segoeui.ttf', bold: 'segoeuib.ttf', italics: 'segoeuii.ttf', bolditalics: 'segoeuiz.ttf' };
		const loaded: Record<string, string> = {};
		for (const file of Object.values(files)) {
			loaded[file] = fs.readFileSync(path.join(dir, file)).toString('base64');
		}
		pdfMake.addVirtualFileSystem(loaded);
		pdfMake.addFonts({ 'Segoe UI': files });
		fonts = 'Segoe UI';
	} catch {
		// not Windows, or the fonts aren't there: Roboto
	}
	return fonts;
}

/** The Query as a PDF report. */
export async function queryPdf(query: Query, topic: string, options?: PdfOptions): Promise<Uint8Array> {
	return pdfMake.createPdf(pdfDefinition(query, topic, options, reportFont())).getBuffer();
}
