/*---------------------------------------------------------------------------------------------
 *  Atelier: a Synthesis on the page. Its Markdown is read into tokens (marked) and drawn as React elements -- never
 *  as HTML, so nothing a model or an abstract wrote can run -- and each `[n]` becomes a citation: the paper's details
 *  on hover, the paper itself on click.
 *--------------------------------------------------------------------------------------------*/

import { marked, Token, Tokens } from 'marked';
import { Fragment, ReactNode, useMemo, useState } from 'react';
import { CitedPaper } from '../shared/api';
import { host } from './hooks';

interface Context {
	readonly papers: readonly CitedPaper[];
	/** Called with a citation's number when it is clicked. */
	readonly onCite?: (n: number) => void;
}

export function paperLink(paper: CitedPaper): string | undefined {
	return paper.doi ? `https://doi.org/${paper.doi}` : paper.fullTextUrl ?? paper.pdfUrl ?? (paper.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${paper.pmid}/` : undefined);
}

export const firstAuthor = (paper: CitedPaper) => paper.authors.length ? `${paper.authors[0]}${paper.authors.length > 1 ? ' et al.' : ''}` : 'Unknown authors';

/** A citation: its number, and on hover the paper it stands for (placed within the window, wherever the number is). */
function Cite({ n, context }: { n: number; context: Context }) {
	const paper = context.papers[n - 1];
	const [at, setAt] = useState<{ left: number; bottom: number }>();
	if (!paper) {
		return <>[{n}]</>;
	}
	const show = (element: HTMLElement) => {
		const rect = element.getBoundingClientRect();
		const width = 300;
		setAt({ left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)), bottom: window.innerHeight - rect.top + 6 });
	};
	return (
		<button type="button" className="at-cite" aria-label={`Source ${n}: ${paper.title}`}
			onMouseEnter={e => show(e.currentTarget)} onMouseLeave={() => setAt(undefined)}
			onFocus={e => show(e.currentTarget)} onBlur={() => setAt(undefined)}
			onClick={() => context.onCite ? context.onCite(n) : void host.openLink(paperLink(paper) ?? '')}>
			{n}
			{at && (
				<span className="at-cite__tip" style={{ left: at.left, bottom: at.bottom }} role="tooltip">
					<span className="at-cite__head">
						<span className="at-cite__source">Source {n}</span>
						<span className="at-cite__where">{[paper.year, paper.journal].filter(Boolean).join(' · ')}</span>
					</span>
					<strong className="at-cite__title">{paper.title}</strong>
					<span className="at-cite__snippet">{paper.extraction?.answer && paper.extraction.answer !== '-' ? paper.extraction.answer : firstAuthor(paper)}</span>
				</span>
			)}
		</button>
	);
}

/** Text with its `[n]` citations. */
function withCitations(text: string, context: Context, key: string): ReactNode {
	const parts = text.split(/\[(\d{1,3})\]/g);
	if (parts.length === 1) {
		return text;
	}
	return parts.map((part, i) => i % 2 ? <Cite key={`${key}-${i}`} n={Number(part)} context={context} /> : <Fragment key={`${key}-${i}`}>{part}</Fragment>);
}

function inline(tokens: readonly Token[] | undefined, context: Context, prefix: string): ReactNode[] {
	return (tokens ?? []).map((token, i) => {
		const key = `${prefix}.${i}`;
		const t = token as Tokens.Generic;
		switch (token.type) {
			case 'strong': return <strong key={key}>{inline(t.tokens, context, key)}</strong>;
			case 'em': return <em key={key}>{inline(t.tokens, context, key)}</em>;
			case 'del': return <del key={key}>{inline(t.tokens, context, key)}</del>;
			case 'codespan': return <code key={key}>{t.text}</code>;
			case 'br': return <br key={key} />;
			case 'link': {
				const href = String(t.href ?? '');
				return <a key={key} href={href} onClick={e => { e.preventDefault(); void host.openLink(href); }}>{inline(t.tokens, context, key)}</a>;
			}
			case 'image': return <Fragment key={key}>{t.text}</Fragment>;
			case 'text': return t.tokens?.length ? <Fragment key={key}>{inline(t.tokens, context, key)}</Fragment> : <Fragment key={key}>{withCitations(String(t.text ?? ''), context, key)}</Fragment>;
			case 'escape': return <Fragment key={key}>{t.text}</Fragment>;
			// markup a model wrote is shown as it was written, not run
			default: return <Fragment key={key}>{withCitations(String(t.raw ?? ''), context, key)}</Fragment>;
		}
	});
}

function blocks(tokens: readonly Token[], context: Context, prefix: string): ReactNode[] {
	return tokens.map((token, i) => {
		const key = `${prefix}.${i}`;
		const t = token as Tokens.Generic;
		switch (token.type) {
			case 'space': return null;
			case 'hr': return <hr key={key} />;
			case 'heading': {
				// the Synthesis sits under the query's own heading: its headings start a level below
				const Tag = (`h${Math.min(6, Number(t.depth) + 2)}`) as 'h3';
				return <Tag key={key}>{inline(t.tokens, context, key)}</Tag>;
			}
			case 'paragraph': return <p key={key}>{inline(t.tokens, context, key)}</p>;
			case 'text': return <p key={key}>{t.tokens?.length ? inline(t.tokens, context, key) : withCitations(String(t.text ?? ''), context, key)}</p>;
			case 'blockquote': return <blockquote key={key}>{blocks(t.tokens ?? [], context, key)}</blockquote>;
			case 'code': return <pre key={key}><code>{t.text}</code></pre>;
			case 'list': {
				const list = token as Tokens.List;
				const items = list.items.map((item, j) => {
					const itemKey = `${key}.${j}`;
					// a tight list's items hold one text token: its words go in the item, without a paragraph
					const only = item.tokens.length === 1 && item.tokens[0].type === 'text' ? item.tokens[0] as Tokens.Text : undefined;
					return <li key={itemKey}>{only ? (only.tokens?.length ? inline(only.tokens, context, itemKey) : withCitations(only.text, context, itemKey)) : blocks(item.tokens, context, itemKey)}</li>;
				});
				return list.ordered ? <ol key={key} start={Number(list.start) || 1}>{items}</ol> : <ul key={key}>{items}</ul>;
			}
			case 'table': {
				const table = token as Tokens.Table;
				const align = (j: number) => ({ textAlign: table.align[j] ?? undefined });
				return (
					<div key={key} className="at-table-wrap">
						<table>
							<thead><tr>{table.header.map((cell, j) => <th key={j} style={align(j)}>{inline(cell.tokens, context, `${key}.h${j}`)}</th>)}</tr></thead>
							<tbody>{table.rows.map((row, r) => <tr key={r}>{row.map((cell, j) => <td key={j} style={align(j)}>{inline(cell.tokens, context, `${key}.${r}.${j}`)}</td>)}</tr>)}</tbody>
						</table>
					</div>
				);
			}
			default: return <p key={key}>{withCitations(String(t.raw ?? ''), context, key)}</p>;
		}
	});
}

export function Markdown({ text, papers, onCite }: { text: string; papers: readonly CitedPaper[]; onCite?: (n: number) => void }) {
	const tokens = useMemo(() => {
		try {
			// `[1, 2]`, as models write it despite being asked not to, is `[1][2]`
			return marked.lexer(text.replace(/\[(\d+(?:\s*[,;]\s*\d+)+)\]/g, (_whole, list: string) => list.split(/[,;]/).map(n => `[${n.trim()}]`).join('')), { gfm: true });
		} catch {
			return undefined;
		}
	}, [text]);
	const context = { papers, onCite };
	return <div className="at-prose">{tokens ? blocks(tokens, context, 'm') : <p>{text}</p>}</div>;
}
