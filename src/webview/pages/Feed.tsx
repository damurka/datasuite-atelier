/*---------------------------------------------------------------------------------------------
 *  Atelier: a Session -- its Queries one after another (the question, the Atelier Meter, the Synthesis, the papers it
 *  cites with their filters), the Query being worked on, and the box for the follow-up.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import { AppState, CitationStyle, CitedPaper, DownloadKind, Meter, PdfOptions, PdfTheme, Query, Run, Source, Stance } from '../../shared/api';
import { CITATION_STYLE_NAMES } from './Settings';
import { Empty, ErrorLine, Icon, ModelPicker, PromptBox } from '../components';
import { host, useAction, useLoad } from '../hooks';
import { firstAuthor, Markdown, paperLink } from '../Markdown';

const SOURCE_NAMES: Record<Source, string> = { pubmed: 'PubMed', europepmc: 'Europe PMC', openalex: 'OpenAlex', semanticscholar: 'Semantic Scholar', crossref: 'Crossref', core: 'CORE', arxiv: 'arXiv', citations: 'Citation trail', atelier: 'Read before' };
const STANCES: readonly Stance[] = ['yes', 'possibly', 'mixed', 'no'];
const STANCE_NAMES: Record<Stance, string> = { yes: 'Yes', possibly: 'Possibly', mixed: 'Mixed', no: 'No' };
const known = (value: string | undefined): value is string => !!value && value !== '-';
const anchor = (queryId: string, n: number) => `paper-${queryId}-${n}`;

/** The sample size as a number, when the paper gives one ("12,450 women" is 12450). */
function sampleSize(paper: CitedPaper): number | undefined {
	const digits = /\d[\d,. ]*/.exec(paper.extraction?.sampleSize ?? '')?.[0].replace(/[^\d]/g, '');
	return digits ? Number(digits) : undefined;
}

/** What sets a paper apart as evidence, each with why. */
function qualitySignals(paper: CitedPaper): { label: string; why: string; warn?: boolean }[] {
	const signals: { label: string; why: string; warn?: boolean }[] = [];
	const age = Math.max(1, new Date().getFullYear() - (paper.year ?? new Date().getFullYear()) + 1);
	if (paper.citationCount >= 100 || (paper.citationCount >= 20 && paper.citationCount / age >= 10)) {
		signals.push({ label: 'Highly cited', why: `${paper.citationCount} citations${paper.year ? `, about ${Math.round(paper.citationCount / age)} a year` : ''}` });
	}
	if (paper.journalImpact !== undefined && paper.journalImpact >= 5) {
		signals.push({ label: 'High-impact journal', why: `Papers in ${paper.journal || 'this journal'} are cited ${paper.journalImpact} times on average within two years (OpenAlex)` });
	}
	const n = sampleSize(paper);
	if (n !== undefined && n >= 1000) {
		signals.push({ label: 'Large sample', why: `N = ${n.toLocaleString()}` });
	}
	if (paper.extraction?.fullText) {
		signals.push({ label: 'Full text read', why: 'The AI read the open-access full text, not the abstract alone' });
	}
	if (paper.extraction?.misleadingAbstract) {
		signals.push({ label: 'Abstract may overstate', why: paper.extraction.fidelity ?? 'The abstract claims more than the full text shows', warn: true });
	}
	return signals;
}

// ---- Filters over a Query's papers. A paper keeps its number whatever is shown.

interface Filters {
	types: ReadonlySet<string>;
	since: number;
	minN: number;
	openAccess: boolean;
	stance: Stance | '';
	words: string;
	sort: 'rank' | 'relevance' | 'year' | 'citations';
}
const NO_FILTERS: Filters = { types: new Set(), since: 0, minN: 0, openAccess: false, stance: '', words: '', sort: 'rank' };
type Numbered = { paper: CitedPaper; n: number };

function applyFilters(papers: readonly Numbered[], f: Filters): Numbered[] {
	const words = f.words.toLowerCase().split(/\s+/).filter(Boolean);
	const shown = papers.filter(({ paper }) => {
		const e = paper.extraction;
		if (f.types.size && !f.types.has(paper.studyType)) { return false; }
		if (f.since && !(paper.year && paper.year >= f.since)) { return false; }
		if (f.minN && !((sampleSize(paper) ?? 0) >= f.minN)) { return false; }
		if (f.openAccess && !paper.pdfUrl && !paper.pmcid) { return false; }
		if (f.stance && e?.stance !== f.stance) { return false; }
		if (words.length) {
			const text = [paper.title, paper.journal, paper.authors.join(' '), e?.country, e?.population, e?.methods, e?.outcomes, e?.answer].join(' ').toLowerCase();
			if (!words.every(word => text.includes(word))) { return false; }
		}
		return true;
	});
	const by: Record<Filters['sort'], (a: Numbered, b: Numbered) => number> = {
		rank: (a, b) => a.n - b.n,
		relevance: (a, b) => (b.paper.extraction?.relevance ?? 0) - (a.paper.extraction?.relevance ?? 0),
		year: (a, b) => (b.paper.year ?? 0) - (a.paper.year ?? 0),
		citations: (a, b) => b.paper.citationCount - a.paper.citationCount
	};
	return shown.sort(by[f.sort]);
}

function FilterBar({ papers, filters, setFilters, hasStances }: { papers: readonly CitedPaper[]; filters: Filters; setFilters: (filters: Filters) => void; hasStances: boolean }) {
	const types = [...new Set(papers.map(paper => paper.studyType))].filter(type => type !== 'unspecified').sort();
	const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters({ ...filters, [key]: value });
	const active = filters.types.size > 0 || !!filters.since || !!filters.minN || filters.openAccess || !!filters.stance || !!filters.words;
	const year = new Date().getFullYear();
	return (
		<div className="at-filters">
			<div className="at-filters__row">
				<label>Since
					<select value={filters.since} onChange={e => set('since', Number(e.target.value))}>
						<option value={0}>Any year</option>
						{[year - 2, year - 5, year - 10, year - 20].map(y => <option key={y} value={y}>{y}</option>)}
					</select>
				</label>
				<label>Sample
					<select value={filters.minN} onChange={e => set('minN', Number(e.target.value))}>
						<option value={0}>Any size</option>
						{[50, 100, 500, 1000, 10000].map(n => <option key={n} value={n}>{n.toLocaleString()}+</option>)}
					</select>
				</label>
				{hasStances && (
					<label>Says
						<select value={filters.stance} onChange={e => set('stance', e.target.value as Stance | '')}>
							<option value="">Anything</option>
							{STANCES.map(stance => <option key={stance} value={stance}>{STANCE_NAMES[stance]}</option>)}
						</select>
					</label>
				)}
				<label>Sort
					<select value={filters.sort} onChange={e => set('sort', e.target.value as Filters['sort'])}>
						<option value="rank">Best evidence</option>
						<option value="relevance">Relevance alone</option>
						<option value="year">Newest</option>
						<option value="citations">Most cited</option>
					</select>
				</label>
				<label className="at-filters__check"><input type="checkbox" checked={filters.openAccess} onChange={e => set('openAccess', e.target.checked)} /> Open access</label>
				<input type="text" className="at-filters__words" value={filters.words} onChange={e => set('words', e.target.value)} placeholder="Country, population, outcome..." aria-label="Filter the papers by words" />
				{active && <button type="button" className="at-link-btn" onClick={() => setFilters({ ...NO_FILTERS, sort: filters.sort })}><Icon name="clear-all" /> Clear</button>}
			</div>
			{types.length > 1 && (
				<div className="at-filters__row">
					{types.map(type => {
						const on = filters.types.has(type);
						return <button key={type} type="button" className={`at-chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => {
							const next = new Set(filters.types);
							if (!next.delete(type)) { next.add(type); }
							set('types', next);
						}}>{type} <span>{papers.filter(paper => paper.studyType === type).length}</span></button>;
					})}
				</div>
			)}
		</div>
	);
}

// ---- Downloads

const DOWNLOADS: { kind: DownloadKind; icon: string; label: string; hint: string }[] = [
	{ kind: 'pdf', icon: 'file-pdf', label: 'Report (PDF)', hint: 'The summary, cited and referenced in the citation style; with the evidence table when Table is selected' },
	{ kind: 'tables', icon: 'table', label: 'Tables (CSV)', hint: 'The summary\'s tables and the evidence table' },
	{ kind: 'papers', icon: 'list-flat', label: 'Papers and extracted data (CSV)', hint: 'Every reference, with all that was read from it' },
	{ kind: 'references', icon: 'references', label: 'References (formatted list)', hint: 'Written in the citation style' },
	{ kind: 'ris', icon: 'library', label: 'References (RIS)', hint: 'For Zotero, EndNote, Mendeley' },
	{ kind: 'bibtex', icon: 'bracket', label: 'References (BibTeX)', hint: 'For LaTeX' }
];

/** The window's colours, when its theme is light: the PDF is drawn with them, to look as the screen does. */
function pdfTheme(): PdfTheme | undefined {
	if (!document.body.classList.contains('vscode-light')) {
		return undefined;
	}
	const css = getComputedStyle(document.body);
	const color = (name: string) => css.getPropertyValue(name).trim() || undefined;
	return { accent: color('--vscode-textLink-foreground'), badgeBackground: color('--vscode-badge-background'), badgeForeground: color('--vscode-badge-foreground') };
}

function DownloadMenu({ download }: { download: (kind: DownloadKind) => void }) {
	const menu = useRef<HTMLDetailsElement>(null);
	// the citation style the report and the reference list are written in: read when the menu opens, kept when changed
	const [style, setStyle] = useState<CitationStyle>();
	const loadStyle = () => { if (menu.current?.open) { host.getSettings().then(settings => setStyle(settings.citationStyle), () => { }); } };
	// a click anywhere else closes it
	useEffect(() => {
		const close = (event: MouseEvent) => {
			if (menu.current?.open && !menu.current.contains(event.target as Node)) {
				menu.current.open = false;
			}
		};
		document.addEventListener('click', close);
		return () => document.removeEventListener('click', close);
	}, []);
	return (
		<details className="at-menu" ref={menu} onToggle={loadStyle}>
			<summary className="at-btn"><Icon name="desktop-download" /> Download <Icon name="chevron-down" /></summary>
			<div className="at-menu__list" role="menu">
				<label className="at-menu__style">Citation style
					<select value={style ?? 'vancouver'} onChange={e => { const next = e.target.value as CitationStyle; setStyle(next); void host.updateSetting('citationStyle', next); }}>
						{Object.entries(CITATION_STYLE_NAMES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
					</select>
				</label>
				{DOWNLOADS.map(item => (
					<button key={item.kind} type="button" role="menuitem" onClick={() => { if (menu.current) { menu.current.open = false; } download(item.kind); }}>
						<Icon name={item.icon} />
						<span><strong>{item.label}</strong><small>{item.hint}</small></span>
					</button>
				))}
			</div>
		</details>
	);
}

// ---- The Atelier Meter

function MeterBar({ meter, count }: { meter: Meter; count: number }) {
	const lead = STANCES.reduce((best, stance) => meter[stance] > meter[best] ? stance : best, 'yes' as Stance);
	return (
		<div className="at-meter" role="img" aria-label={`Atelier Meter: ${STANCES.map(stance => `${STANCE_NAMES[stance]} ${meter[stance]}%`).join(', ')}`}>
			<div className="at-meter__head">
				<h2>Atelier Meter</h2>
				<span className="at-muted" title="Each paper counts for its evidence tier (a meta-analysis more than a case report) plus its citations">
					{meter.papers} of {count} papers take a side · weighted by study design and citations
				</span>
			</div>
			<div className="at-meter__bar">
				{STANCES.filter(stance => meter[stance] > 0).map(stance => <span key={stance} className={`at-meter__seg at-stance--${stance}`} style={{ width: `${meter[stance]}%` }} />)}
			</div>
			<div className="at-meter__legend">
				{STANCES.map(stance => <span key={stance} className={stance === lead ? 'is-lead' : ''}><i className={`at-meter__dot at-stance--${stance}`} /> {STANCE_NAMES[stance]} <strong>{meter[stance]}%</strong></span>)}
			</div>
		</div>
	);
}

// ---- Papers

function QueryHeader({ prompt, model, note, searchQuery }: { prompt: string; model: string; note: string; searchQuery?: string }) {
	return (
		<header className="at-query__header">
			<h1>{prompt}</h1>
			<div className="at-query__meta">
				<span><Icon name="sparkle" /> {model}</span>
				<span><Icon name="book" /> {note}</span>
			</div>
			{searchQuery && <p className="at-query__searched"><Icon name="search" /> Searched for: {searchQuery}</p>}
		</header>
	);
}

function PaperCard({ paper, n, id, sessionId, model, selected, toggle }: { paper: CitedPaper; n: number; id: string; sessionId: string; model: string | undefined; selected?: boolean; toggle?: () => void }) {
	const [open, setOpen] = useState(false);
	const [summary, setSummary] = useState<{ text?: string; error?: string }>();
	// the user's own judgment of the paper: the Session's later searches learn from it
	const [judged, setJudged] = useState<1 | -1 | undefined>(paper.feedback);
	const judge = (value: 1 | -1) => {
		const next = judged === value ? undefined : value;
		setJudged(next);
		void host.rate(sessionId, paper.fingerprint, next ?? 0);
	};
	const link = paperLink(paper);
	const e = paper.extraction;
	const details: [string, string | undefined][] = [
		['Population', e?.population], ['Methods', e?.methods], ['Results', e?.results], ['Outcomes', e?.outcomes],
		['Sample size', e?.sampleSize], ['Studies included', e?.studyCount], ['Duration', e?.duration], ['Location', e?.country]
	];
	// the Paper Summary is written the first time the paper is opened, and kept
	const summarize = () => {
		if (!model) {
			return;
		}
		setSummary({});
		host.summarizePaper(sessionId, paper.fingerprint, model).then(text => setSummary({ text }), (error: Error) => setSummary({ error: error.message }));
	};
	const toggleOpen = () => {
		if (!open && !summary) {
			summarize();
		}
		setOpen(!open);
	};
	return (
		<article className="at-paper" id={id}>
			<div className="at-paper__n">
				<span>{String(n).padStart(2, '0')}</span>
				{toggle && <input type="checkbox" checked={!!selected} onChange={toggle} title="Ask the follow-up about this paper" aria-label={`Select paper ${n} for the follow-up`} />}
			</div>
			<div className="at-paper__body">
				<h3>{link ? <a href={link} onClick={ev => { ev.preventDefault(); void host.openLink(link); }}>{paper.title}</a> : paper.title}</h3>
				<p className="at-paper__byline">
					<span className="at-paper__author">{firstAuthor(paper)}</span>
					{paper.year ? ` · ${paper.year}` : ''}{` · ${paper.citationCount} citation${paper.citationCount === 1 ? '' : 's'}`}{paper.journal ? <> · <em>{paper.journal}</em></> : null}
				</p>
				<p className="at-paper__tags">
					{e?.stance && <span className={`at-tag at-tag--stance at-stance--${e.stance}`} title="What this paper says to the question">{STANCE_NAMES[e.stance]}</span>}
					{paper.studyType !== 'unspecified' && <span className="at-tag at-tag--type">{paper.studyType}</span>}
					{qualitySignals(paper).map(signal => <span key={signal.label} className={`at-tag ${signal.warn ? 'at-tag--error' : 'at-tag--quality'}`} title={signal.why}><Icon name={signal.warn ? 'warning' : 'verified'} /> {signal.label}</span>)}
					{e && <span className="at-tag" title={`How directly the AI judged the paper to answer the question. The references are in order of evidence: this, plus up to 10 for the strength of the study design, then citations and journal (${paper.score} here).`}>Relevance {e.relevance}</span>}
					{paper.similarity !== undefined && <span className="at-tag" title="Cosine similarity of the paper's and the question's embeddings">Similarity {paper.similarity.toFixed(2)}</span>}
					{paper.sources.map(source => <span key={source} className="at-tag at-tag--source">{SOURCE_NAMES[source] ?? source}</span>)}
				</p>
				{known(e?.answer) && <p className="at-paper__answer">{e!.answer}</p>}
				{open && (
					<dl className="at-paper__details">
						<div className="at-paper__wide">
							<dt>Summary for this question</dt>
							<dd>
								{!summary || (!summary.text && !summary.error) ? <span className="at-muted"><Icon name="loading" spin /> {model ? 'Reading the paper...' : 'Choose an AI model to summarize the paper.'}</span> : null}
								{summary?.text && <Markdown text={summary.text} papers={[]} />}
								{summary?.error && <span className="at-muted">{summary.error} <button type="button" className="at-link-btn" onClick={summarize}>Try again</button></span>}
							</dd>
						</div>
						{details.filter(([, value]) => known(value)).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
						{e?.misleadingAbstract && <div className="at-paper__wide"><dt>Abstract against full text</dt><dd>{e.fidelity}</dd></div>}
						{paper.abstract && <div className="at-paper__wide at-paper__abstract"><dt>Abstract</dt><dd>{paper.abstract}</dd></div>}
					</dl>
				)}
				<div className="at-paper__actions">
					<button type="button" className="at-link-btn" onClick={toggleOpen}><Icon name={open ? 'chevron-up' : 'chevron-down'} /> {open ? 'Less' : 'Details'}</button>
					{paper.pdfUrl && <button type="button" className="at-link-btn" onClick={() => void host.openLink(paper.pdfUrl!)}><Icon name="file-pdf" /> PDF</button>}
					{link && <button type="button" className="at-link-btn" onClick={() => void host.openLink(link)}><Icon name="link-external" /> Open</button>}
					<span className="at-paper__judge">
						<button type="button" className={`at-icon-btn${judged === 1 ? ' is-on' : ''}`} aria-pressed={judged === 1} onClick={() => judge(1)}
							title="This paper answers my question. Later searches in this session look for more like it and follow its citations."><Icon name="thumbsup" /></button>
						<button type="button" className={`at-icon-btn${judged === -1 ? ' is-on is-no' : ''}`} aria-pressed={judged === -1} onClick={() => judge(-1)}
							title="This paper does not answer my question. Later searches in this session leave it, and papers like it, out."><Icon name="thumbsdown" /></button>
					</span>
				</div>
			</div>
		</article>
	);
}

function PaperTable({ papers, queryId }: { papers: readonly Numbered[]; queryId: string }) {
	const cell = (value: string | undefined) => known(value) ? value : '-';
	const stances = papers.some(({ paper }) => paper.extraction?.stance);
	return (
		<div className="at-table-wrap at-papers-table">
			<table>
				<thead><tr><th>#</th><th>Paper</th>{stances && <th>Says</th>}<th>Design and methods</th><th>Population</th><th>N</th><th>Outcomes</th><th>Location</th><th title="Whether the row's facts were read from the paper's full text or only its abstract">Read from</th></tr></thead>
				<tbody>
					{papers.map(({ paper, n }) => {
						const link = paperLink(paper);
						return (
							<tr key={paper.fingerprint} id={anchor(queryId, n)}>
								<td>{n}</td>
								<td>
									{link ? <a href={link} onClick={ev => { ev.preventDefault(); void host.openLink(link); }}>{paper.title}</a> : paper.title}
									<div className="at-muted">{firstAuthor(paper)}{paper.year ? ` · ${paper.year}` : ''}{` · ${paper.citationCount} citations`}</div>
								</td>
								{stances && <td>{paper.extraction?.stance ? <span className={`at-tag at-tag--stance at-stance--${paper.extraction.stance}`}>{STANCE_NAMES[paper.extraction.stance]}</span> : '-'}</td>}
								<td>{paper.studyType !== 'unspecified' && <div className="at-table__design">{paper.studyType}</div>}{known(paper.extraction?.methods) ? paper.extraction!.methods : paper.studyType === 'unspecified' ? '-' : null}</td>
								<td>{cell(paper.extraction?.population)}</td>
								<td>{cell(paper.extraction?.sampleSize)}</td>
								<td>{cell(paper.extraction?.outcomes)}</td>
								<td>{cell(paper.extraction?.country)}</td>
								<td>{paper.extraction ? <span className={`at-tag${paper.extraction.fullText ? ' at-tag--quality' : ''}`}>{paper.extraction.fullText ? 'Full text' : 'Abstract'}</span> : '-'}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

function QueryBlock({ sessionId, query, model, selection }: { sessionId: string; query: Query; model: string | undefined; selection?: { selected: ReadonlySet<string>; toggle: (fingerprint: string) => void } }) {
	const [view, setView] = useState<'list' | 'table'>('list');
	const [filters, setFilters] = useState<Filters>(NO_FILTERS);
	const [run, error, , dismiss] = useAction();
	const [copied, setCopied] = useState(false);
	const search = query.route === 'search';
	const count = query.papers.length;
	// a follow-up's references are the papers its answer cites, under the numbers it cites them by, shown as a
	// search's are; with none cited, all the papers it was answered from
	const numbered = query.papers.map((paper, i): Numbered => ({ paper, n: i + 1 }));
	const citedNumbers = new Set([...query.synthesis.matchAll(/\[(\d{1,3})\]/g)].map(match => Number(match[1])));
	const citedOnly = numbered.filter(({ n }) => citedNumbers.has(n));
	const listed = search || !citedOnly.length ? numbered : citedOnly;
	const shown = applyFilters(listed, filters);
	const note = search
		? `${count} reference${count === 1 ? '' : 's'}${query.read ? ` · ${query.read} read of ${query.candidates} found` : query.candidates ? ` of ${query.candidates} found` : ''}${query.ranking ? ` · ranked by ${query.ranking === 'embeddings' ? 'meaning and keywords' : 'keywords'}` : ''}`
		: `${listed.length} reference${listed.length === 1 ? '' : 's'} · answered from ${count} paper${count === 1 ? '' : 's'}`;
	// the PDF is the Query as it is shown now: this window's colours, and the references as selected -- the list or
	// the table, those the filters leave, in the order they are sorted
	const download = (kind: DownloadKind) => {
		const options: PdfOptions | undefined = kind === 'pdf' ? { theme: pdfTheme(), view, shown: shown.map(({ n }) => n) } : undefined;
		void run(() => host.download(sessionId, query.id, kind, options));
	};
	const goTo = (n: number) => {
		const show = () => {
			const element = document.getElementById(anchor(query.id, n));
			if (!element) {
				return false;
			}
			element.scrollIntoView({ behavior: 'smooth', block: 'center' });
			element.classList.add('at-flash');
			setTimeout(() => element.classList.remove('at-flash'), 1600);
			return true;
		};
		if (show()) {
			return;
		}
		// the paper is filtered out: the filters are cleared to show it
		if (query.papers[n - 1]) {
			setFilters({ ...NO_FILTERS, sort: filters.sort });
			setTimeout(show, 60);
		}
	};
	return (
		<section className="at-query">
			<QueryHeader prompt={query.prompt} model={query.model} note={note} searchQuery={query.searchQuery} />
			{search && !!query.read && !!query.candidates && (
				<p className="at-query__searched">The databases returned {query.candidates} unique papers. Going down the ranking, {query.read} were read in full; {count} of those answer the question and are cited{query.read - count > 0 ? `, ${query.read - count} did not` : ''}{query.offTopic ? `; ${query.offTopic} were set aside as off-topic by a first screening of every paper` : ''}{query.candidates - query.read - (query.offTopic ?? 0) > 0 ? `, and ${query.candidates - query.read - (query.offTopic ?? 0)} were not read` : ''}.</p>
			)}
			{query.meter && <MeterBar meter={query.meter} count={count} />}
			<div className="at-synthesis">
				<div className="at-synthesis__title">
					<h2>{search ? 'Synthesis Summary' : 'Answer'}</h2>
					<button type="button" className="at-link-btn" onClick={() => void run(async () => { await host.copy(query.synthesis); setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
						<Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : 'Copy'}
					</button>
				</div>
				<Markdown text={query.synthesis} papers={query.papers} onCite={goTo} />
			</div>
			<ErrorLine error={error} onDismiss={dismiss} />
			{listed.length > 0 && (
				<div className="at-results">
					<div className="at-results__bar">
						<h2>{search ? 'Results' : 'References'}{shown.length !== listed.length ? <span className="at-muted"> {shown.length} of {listed.length}</span> : null}</h2>
						<div className="at-results__tools">
							<DownloadMenu download={download} />
							<div className="at-toggle" role="group" aria-label="How the papers are shown">
								<button type="button" className={view === 'list' ? 'is-on' : ''} onClick={() => setView('list')}>List</button>
								<button type="button" className={view === 'table' ? 'is-on' : ''} onClick={() => setView('table')}>Table</button>
							</div>
						</div>
					</div>
					<FilterBar papers={listed.map(({ paper }) => paper)} filters={filters} setFilters={setFilters} hasStances={listed.some(({ paper }) => paper.extraction?.stance)} />
					{shown.length === 0 && <p className="at-working">No paper matches these filters.</p>}
					{view === 'list'
						? shown.map(({ paper, n }) => <PaperCard key={paper.fingerprint} paper={paper} n={n} id={anchor(query.id, n)} sessionId={sessionId} model={model}
							selected={selection?.selected.has(paper.fingerprint)} toggle={selection ? () => selection.toggle(paper.fingerprint) : undefined} />)
						: shown.length > 0 && <PaperTable papers={shown} queryId={query.id} />}
				</div>
			)}
			{listed.length === 0 && (
				<div className="at-results__solo"><DownloadMenu download={download} /></div>
			)}
		</section>
	);
}

// ---- A Query being worked on

const STEPS: { phase: Run['phase']; label: string }[] = [
	{ phase: 'planning', label: 'Planning the searches' },
	{ phase: 'searching', label: 'Asking the databases' },
	{ phase: 'ranking', label: 'Completing and ranking the papers' },
	{ phase: 'screening', label: 'Screening every paper against the question' },
	{ phase: 'widening', label: 'Following citations and widening the search' },
	{ phase: 'reading', label: 'Reading the best papers' },
	{ phase: 'synthesizing', label: 'Writing the synthesis' }
];

function RunBlock({ run, dismiss }: { run: Run; dismiss: () => void }) {
	const ended = run.phase === 'failed' || run.phase === 'stopped';
	const at = STEPS.findIndex(step => step.phase === run.phase);
	const note = run.phase === 'routing' ? 'Reading the question...' : run.route === 'chat' ? 'Answering from the papers at hand...' : run.candidates !== undefined ? `${run.candidates} papers found` : 'Searching the literature...';
	return (
		<section className="at-query at-run" aria-live="polite">
			<QueryHeader prompt={run.prompt} model={run.model} note={note} searchQuery={run.searchQuery} />
			{run.route === 'search' && !ended && (
				<ol className="at-steps">
					{STEPS.map((step, i) => (
						<li key={step.phase} className={i < at ? 'is-done' : i === at ? 'is-now' : ''}>
							<Icon name={i < at ? 'pass-filled' : i === at ? 'loading' : 'circle-large'} spin={i === at} />
							<div>
								<span>{step.label}</span>
								{step.phase === 'searching' && i <= at && run.sources && (
									<div className="at-steps__sources">
										{run.sources.map(source => (
											<span key={source.source} className={`at-tag${source.error ? ' at-tag--error' : ''}`} title={source.error}>
												{SOURCE_NAMES[source.source]}: {source.error ? 'no answer' : source.count ?? '...'}
											</span>
										))}
									</div>
								)}
								{step.phase === 'ranking' && i < at && run.ranking && <div className="at-muted">Closeness by {run.ranking === 'embeddings' ? 'meaning (DataSuite embeddings) and keywords' : 'keywords (no embeddings)'}</div>}
								{step.phase === 'screening' && i <= at && run.toScreen !== undefined && (
									<div className="at-muted">{i < at ? `${run.toScreen} rated${run.offTopic !== undefined ? ` · ${run.offTopic} set aside as off-topic` : ''}` : `${run.screened ?? 0} of ${run.toScreen} rated`}</div>
								)}
								{step.phase === 'widening' && i <= at && (run.widened ?? []).map(line => <div key={line} className="at-muted">{line}</div>)}
								{step.phase === 'reading' && i <= at && run.toRead !== undefined && (
									<div className="at-steps__reading">
										<progress value={Math.min(run.relevant ?? 0, run.wanted ?? 1)} max={run.wanted || 1} />
										<span className="at-muted">{run.relevant ?? 0} of {run.wanted ?? '?'} relevant papers found · {run.read ?? 0} read (up to {run.toRead})</span>
									</div>
								)}
							</div>
						</li>
					))}
				</ol>
			)}
			{(run.phase === 'routing' || run.phase === 'answering') && !run.text && <p className="at-working"><Icon name="loading" spin /> {note}</p>}
			{run.text && !ended && (
				<div className="at-synthesis at-synthesis--writing">
					<Markdown text={run.text} papers={[]} />
				</div>
			)}
			{!run.text && !ended && run.preview && (
				<div className="at-preview">
					<h3><Icon name="eye" /> First look <span className="at-muted">from the top abstracts, while the papers are read. The synthesis replaces it.</span></h3>
					<Markdown text={run.preview} papers={[]} />
				</div>
			)}
			{!run.text && !ended && !!run.found?.length && (
				<div className="at-found">
					<h3>Papers that answer the question, as they are read</h3>
					{run.found.map(paper => (
						<div key={paper.fingerprint} className="at-found__paper">
							<strong>{paper.title}</strong>
							<span className="at-muted">{paper.byline} · relevance {paper.relevance}</span>
							{known(paper.answer) && <p>{paper.answer}</p>}
						</div>
					))}
				</div>
			)}
			{run.phase === 'failed' && <ErrorLine error={run.error ?? 'Something went wrong.'} onDismiss={dismiss} />}
			{run.phase === 'stopped' && <div className="at-stopped"><Icon name="debug-stop" /> Stopped. <button type="button" className="at-link-btn" onClick={dismiss}>Dismiss</button></div>}
		</section>
	);
}

export function Feed({ sessionId, state, model, setModel, run, dismissRun, open, deleted }: {
	sessionId: string; state: AppState; model: string | undefined; setModel: (id: string) => void;
	run: Run | undefined; dismissRun: () => void; open: (sessionId: string) => void; deleted: () => void;
}) {
	const session = useLoad(() => host.getSession(sessionId), [sessionId], ['sessionsChanged']);
	const [text, setText] = useState('');
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const [act, error, , dismiss] = useAction();
	const end = useRef<HTMLDivElement>(null);
	const queries = session.value?.queries ?? [];
	const working = !!run && run.phase !== 'failed' && run.phase !== 'stopped' && run.phase !== 'done';
	// follow-ups are answered from the papers of the last search: those can be picked out
	const lastSearch = queries.findLast(query => query.route === 'search' && query.papers.length > 0);
	const picked = lastSearch?.papers.filter(paper => selected.has(paper.fingerprint)) ?? [];

	useEffect(() => setSelected(new Set()), [sessionId, lastSearch?.id]);
	// a new question is what to look at; its answer is read from its start
	useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [run?.prompt, run?.phase === 'failed', sessionId]);
	const answered = useRef(queries.length);
	useEffect(() => {
		if (queries.length > answered.current && answered.current > 0) {
			[...document.querySelectorAll('.at-query:not(.at-run)')].at(-1)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
		answered.current = queries.length;
	}, [queries.length]);

	const toggle = (fingerprint: string) => setSelected(current => {
		const next = new Set(current);
		if (!next.delete(fingerprint)) {
			next.add(fingerprint);
		}
		return next;
	});
	const send = () => {
		if (!text.trim() || !model || working) {
			return;
		}
		const prompt = text;
		setText('');
		dismissRun();
		void act(async () => {
			try {
				const id = await host.ask(sessionId, prompt, model, picked.map(paper => paper.fingerprint));
				setSelected(new Set());
				if (id !== sessionId) {
					open(id);
				}
			} catch (e) {
				setText(prompt);
				throw e;
			}
		});
	};

	return (
		<div className="at-feed">
			<div className="at-feed__scroll">
				{!session.loading && !session.value && !run && <Empty icon="search-stop" title="Session not found"><p>It may have been deleted. Ask below to start again.</p></Empty>}
				{session.value && (
					<div className="at-feed__tools">
						<button type="button" className="at-link-btn" title="Delete this session" onClick={() => void act(async () => { if (await host.deleteSession(sessionId)) { deleted(); } })}><Icon name="trash" /> Delete session</button>
					</div>
				)}
				{queries.map(query => <QueryBlock key={query.id} sessionId={sessionId} query={query} model={model} selection={query.id === lastSearch?.id ? { selected, toggle } : undefined} />)}
				{run && run.phase !== 'done' && <RunBlock run={run} dismiss={dismissRun} />}
				<div ref={end} className="at-feed__end" />
			</div>
			<div className="at-composer">
				<ErrorLine error={error ?? session.error} onDismiss={dismiss} />
				<div className="at-ask">
					{picked.length > 0 && (
						<div className="at-pills">
							{picked.map(paper => (
								<span key={paper.fingerprint} className="at-pill">
									<Icon name="file" /><span>{paper.title}</span>
									<button type="button" className="at-icon-btn" onClick={() => toggle(paper.fingerprint)} aria-label="Remove"><Icon name="close" /></button>
								</span>
							))}
						</div>
					)}
					<PromptBox value={text} onChange={setText} onSubmit={send} placeholder={picked.length ? 'Ask about the selected papers...' : 'Ask follow up or request a deep dive...'} />
					<div className="at-ask__bar">
						<ModelPicker models={state.models} value={model} onChange={setModel} />
						{working
							? <button type="button" className="at-btn at-btn--round" onClick={() => void host.stop(sessionId)} title="Stop" aria-label="Stop"><Icon name="debug-stop" /></button>
							: <button type="button" className="at-btn at-btn--primary at-btn--round" onClick={send} disabled={!text.trim() || !model} title="Send" aria-label="Send"><Icon name="arrow-up" /></button>}
					</div>
				</div>
			</div>
		</div>
	);
}
