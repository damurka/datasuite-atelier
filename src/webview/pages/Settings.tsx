/*---------------------------------------------------------------------------------------------
 *  Atelier: the settings -- who the databases are told is asking and the keys that lift their limits, how wide a
 *  search goes, and what is kept on this machine.
 *--------------------------------------------------------------------------------------------*/

import { ReactNode, useEffect, useState } from 'react';
import { ApiKeyName, CitationStyle, ModelInfo, Settings as SettingsData, Source } from '../../shared/api';
import { ErrorLine, Icon } from '../components';
import { host, useAction, useLoad } from '../hooks';

const DATABASES: { name: ApiKeyName; label: string; why: string; url: string }[] = [
	{ name: 'semanticScholar', label: 'Semantic Scholar', why: 'Without a key everyone shares one small allowance, and it often answers "too many requests".', url: 'https://www.semanticscholar.org/product/api#api-key' },
	{ name: 'ncbi', label: 'PubMed (NCBI)', why: '10 requests a second instead of 3.', url: 'https://account.ncbi.nlm.nih.gov/settings/' },
	{ name: 'openAlex', label: 'OpenAlex', why: 'A higher daily allowance.', url: 'https://openalex.org/settings/api' },
	{ name: 'core', label: 'CORE', why: 'Without a key CORE answers slowly, a few requests a minute.', url: 'https://core.ac.uk/services/api#form' }
];

const SOURCES: { id: Source; label: string; what: string }[] = [
	{ id: 'pubmed', label: 'PubMed', what: 'biomedicine' },
	{ id: 'europepmc', label: 'Europe PMC', what: 'life sciences, with open-access full text' },
	{ id: 'openalex', label: 'OpenAlex', what: 'every discipline' },
	{ id: 'semanticscholar', label: 'Semantic Scholar', what: 'every discipline' },
	{ id: 'crossref', label: 'Crossref', what: 'every discipline, by DOI registration' },
	{ id: 'core', label: 'CORE', what: 'open-access repositories: theses, reports, working papers' },
	{ id: 'arxiv', label: 'arXiv', what: 'preprints in physics, mathematics, computing' }
];

export const CITATION_STYLE_NAMES: Record<CitationStyle, string> = {
	vancouver: 'Vancouver: (1\u20133, 5)',
	ama: 'AMA: raised numbers \u00b9\u207b\u00b3',
	ieee: 'IEEE: [1]\u2013[3], [5]',
	apa: 'APA 7th: (Lee et al., 2021)',
	harvard: 'Harvard: (Lee et al., 2021)'
};

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
	return (
		<section className="at-settings__section">
			<h2>{title}</h2>
			{hint && <p className="at-muted">{hint}</p>}
			<div className="at-settings__rows">{children}</div>
		</section>
	);
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<div className="at-settings__row">
			<div className="at-settings__label"><strong>{label}</strong>{hint && <span className="at-muted">{hint}</span>}</div>
			<div className="at-settings__control">{children}</div>
		</div>
	);
}

/** A number that is saved when the box is left (or Enter is pressed), kept within its limits. */
function NumberSetting({ value, min, max, save }: { value: number; min: number; max: number; save: (value: number) => void }) {
	const [text, setText] = useState(String(value));
	useEffect(() => setText(String(value)), [value]);
	const commit = () => {
		const n = Math.round(Number(text));
		if (Number.isFinite(n) && n !== value) {
			save(Math.max(min, Math.min(max, n)));
		} else {
			setText(String(value));
		}
	};
	return <input type="number" className="at-input at-input--number" value={text} min={min} max={max}
		onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} />;
}

/** A database's key: whether one is kept, a box to give or replace it, and Remove. The key itself is never shown. */
function KeySetting({ isSet, save }: { isSet: boolean; save: (key: string) => void }) {
	const [text, setText] = useState('');
	return (
		<div className="at-settings__key">
			<span className={`at-tag ${isSet ? 'at-tag--quality' : ''}`}><Icon name={isSet ? 'pass' : 'circle-slash'} /> {isSet ? 'Key saved' : 'No key'}</span>
			<input type="password" className="at-input" value={text} placeholder={isSet ? 'Replace the key...' : 'Paste the key...'} autoComplete="off"
				onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && text.trim()) { save(text.trim()); setText(''); } }} />
			<button type="button" className="at-btn at-btn--primary" disabled={!text.trim()} onClick={() => { save(text.trim()); setText(''); }}>Save</button>
			{isSet && <button type="button" className="at-btn" onClick={() => save('')}>Remove</button>}
		</div>
	);
}

export function Settings() {
	const loaded = useLoad(() => host.getSettings(), [], ['sessionsChanged']);
	const models: readonly ModelInfo[] = useLoad(() => host.getState(), [], ['stateChanged']).value?.models ?? [];
	const [settings, setSettings] = useState<SettingsData>();
	const [run, error, , dismiss] = useAction();
	const [email, setEmail] = useState('');
	useEffect(() => {
		if (loaded.value) {
			setSettings(loaded.value);
			setEmail(loaded.value.contactEmail);
		}
	}, [loaded.value]);
	if (!settings) {
		return <div className="at-page"><h1>Settings</h1><ErrorLine error={loaded.error} /></div>;
	}
	const apply = (change: () => Promise<SettingsData>) => void run(async () => setSettings(await change()));
	return (
		<div className="at-page at-settings">
			<h1>Settings</h1>
			<ErrorLine error={error} onDismiss={dismiss} />

			<Section title="Literature databases" hint="The databases answer without keys, more slowly and for fewer requests. Keys are kept in DataSuite's secret storage, never in a settings file.">
				<Row label="Contact email" hint="Sent to PubMed and OpenAlex with each request, as they ask of tools: OpenAlex answers faster for it, and NCBI can write before blocking.">
					<input type="email" className="at-input" value={email} placeholder="you@example.org"
						onChange={e => setEmail(e.target.value)} onBlur={() => { if (email.trim() !== settings.contactEmail) { apply(() => host.updateSetting('contactEmail', email.trim())); } }}
						onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} />
				</Row>
				{DATABASES.map(db => (
					<Row key={db.name} label={`${db.label} API key`} hint={<>{db.why} <a href={db.url} onClick={e => { e.preventDefault(); void host.openLink(db.url); }}>Get a key</a></>}>
						<KeySetting isSet={settings.keys[db.name]} save={key => apply(() => host.setApiKey(db.name, key))} />
					</Row>
				))}
			</Section>

			<Section title="Search">
				<Row label="Databases" hint="What a search asks. More databases find more, and take a little longer.">
					<div className="at-settings__checks">
						{SOURCES.map(source => {
							const on = settings.databases.includes(source.id);
							return (
								<label key={source.id} title={source.what}>
									<input type="checkbox" checked={on} disabled={on && settings.databases.length === 1}
										onChange={e => apply(() => host.updateSetting('databases', e.target.checked ? [...settings.databases, source.id] : settings.databases.filter(id => id !== source.id)))} />
									{source.label}
								</label>
							);
						})}
					</div>
				</Row>
				<Row label="Follow citations" hint="From the best papers a search finds: what they cite, what cites them, and what Semantic Scholar finds similar. Finds papers the keyword searches miss.">
					<label className="at-switch"><input type="checkbox" checked={settings.followCitations} onChange={e => apply(() => host.updateSetting('followCitations', e.target.checked))} /> {settings.followCitations ? 'On' : 'Off'}</label>
				</Row>
				<Row label="Model for screening and reading" hint="Most of a search's AI requests screen and read papers. A fast model here makes searches quicker, and keeping to one makes rankings alike from search to search. The model you choose with a question still plans the search and writes the synthesis.">
					<select className="at-input" value={models.some(model => model.id === settings.workModel) ? settings.workModel : ''} onChange={e => apply(() => host.updateSetting('workModel', e.target.value))}>
						<option value="">The model chosen for the question</option>
						{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
					</select>
				</Row>
				<Row label="Papers per database" hint="Asked of each database per search, shared among its queries. A bigger pool finds more of what is relevant; ranking it costs little.">
					<NumberSetting value={settings.maxResultsPerSource} min={5} max={100} save={value => apply(() => host.updateSetting('maxResultsPerSource', value))} />
				</Row>
				<Row label="References wanted" hint="The AI reads down the ranking until this many papers answer the question.">
					<NumberSetting value={settings.referencesWanted} min={1} max={50} save={value => apply(() => host.updateSetting('referencesWanted', value))} />
				</Row>
				<Row label="Most papers read" hint="The limit on papers read in full for one search (one AI request each).">
					<NumberSetting value={settings.papersToRead} min={1} max={200} save={value => apply(() => host.updateSetting('papersToRead', value))} />
				</Row>
				<Row label="Read full text" hint="Where a paper is open access in Europe PMC, read its full text: the table's population, sample size and methods then come from the paper itself, and the abstract is checked against it. Each such paper is a longer request.">
					<label className="at-switch"><input type="checkbox" checked={settings.readFullText} onChange={e => apply(() => host.updateSetting('readFullText', e.target.checked))} /> {settings.readFullText ? 'On' : 'Off'}</label>
				</Row>
			</Section>

			<Section title="References">
				<Row label="Citation style" hint="How the PDF report cites papers in its text -- numbers in parentheses, raised numbers, numbers in square brackets, or author and year -- and writes out its references. The formatted list of references follows it too. On screen, papers are always cited by a number you can point at.">
					<select className="at-input" value={settings.citationStyle} onChange={e => apply(() => host.updateSetting('citationStyle', e.target.value as CitationStyle))}>
						{Object.entries(CITATION_STYLE_NAMES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
					</select>
				</Row>
			</Section>

			<Section title="Data on this computer" hint="Sessions, the papers met in them (kept so a later search recalls them) and their embeddings are stored in DataSuite's storage for this extension, on this computer. (A search itself sends your question and the papers' abstracts to DataSuite's AI and embeddings.)">
				<Row label="Sessions" hint={`${settings.stored.sessions} session${settings.stored.sessions === 1 ? '' : 's'}. One session is deleted from History, or from its own page.`}>
					<button type="button" className="at-btn at-btn--danger" disabled={!settings.stored.sessions} onClick={() => apply(async () => { await host.deleteData('sessions'); return host.getSettings(); })}><Icon name="trash" /> Delete all sessions</button>
				</Row>
				<Row label="Everything" hint={`${settings.stored.papers} paper${settings.stored.papers === 1 ? '' : 's'} with their embeddings and what the AI read from them, and all sessions. Settings and keys stay.`}>
					<button type="button" className="at-btn at-btn--danger" disabled={!settings.stored.papers && !settings.stored.sessions} onClick={() => apply(async () => { await host.deleteData('everything'); return host.getSettings(); })}><Icon name="trash" /> Delete everything</button>
				</Row>
			</Section>
		</div>
	);
}
