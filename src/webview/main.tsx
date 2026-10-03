/*---------------------------------------------------------------------------------------------
 *  Atelier: the webview's React app -- the sidebar (a new search, the history and its latest sessions) and the page:
 *  Home, History, or a Session's feed.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Run, SessionSummary, Target } from '../shared/api';
import { Empty, Icon } from './components';
import { host, useLoad } from './hooks';
import { Feed } from './pages/Feed';
import { History } from './pages/History';
import { Home } from './pages/Home';
import { Settings } from './pages/Settings';
import { onHostEvent, viewState } from './rpc';
import './styles.css';

type Page = { name: 'home' } | { name: 'history' } | { name: 'settings' } | { name: 'session'; id: string };
interface State { page?: Page }

/** How long ago, as the sidebar groups its sessions. */
function ageLabel(time: number): string {
	const now = new Date();
	const days = (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - time) / 86400000;
	if (days <= 0) {
		return 'Today';
	}
	if (days <= 7) {
		return 'Last 7 days';
	}
	if (days <= 30) {
		return 'Last 30 days';
	}
	return new Date(time).getFullYear() === now.getFullYear() ? 'This year' : 'Earlier';
}

function App() {
	const [page, setPage] = useState<Page>(() => viewState.get<State>()?.page ?? { name: 'home' });
	const state = useLoad(() => host.getState(), [], ['stateChanged']);
	const sessions = useLoad(() => host.listSessions(), [], ['sessionsChanged']);
	const [model, setModel] = useState<string>();
	/** The Queries being worked on (and those that failed or were stopped, until dismissed), by Session. */
	const [runs, setRuns] = useState<Record<string, Run>>({});

	useEffect(() => viewState.set<State>({ page }), [page]);
	// opened from DataSuite's side bar or a command, at a place
	useEffect(() => {
		const go = (target: Target | undefined) => {
			if (target) {
				setPage(target.page === 'session' ? { name: 'session', id: target.id } : target.page === 'history' ? { name: 'history' } : target.page === 'settings' ? { name: 'settings' } : { name: 'home' });
			}
		};
		void host.takeNavigation().then(go, () => { });
		return onHostEvent<Target>('navigate', go);
	}, []);
	useEffect(() => {
		void host.listRuns().then(list => setRuns(current => ({ ...Object.fromEntries(list.map(run => [run.sessionId, run])), ...current })), () => { });
		return onHostEvent<Run>('run', run => setRuns(current => {
			if (run.phase !== 'done') {
				return { ...current, [run.sessionId]: run };
			}
			const { [run.sessionId]: _done, ...rest } = current;
			return rest;
		}));
	}, []);

	// the model: the one chosen, while DataSuite still offers it; else the last used; else the first
	const models = state.value?.models ?? [];
	const chosen = models.some(m => m.id === model) ? model : state.value?.model ?? models[0]?.id;
	const dismissRun = (sessionId: string) => setRuns(current => {
		const run = current[sessionId];
		if (!run || (run.phase !== 'failed' && run.phase !== 'stopped')) {
			return current;
		}
		const { [sessionId]: _gone, ...rest } = current;
		return rest;
	});

	// the sidebar's sessions: those with the words searched for, by how long ago they were started
	const [find, setFind] = useState('');
	const words = find.toLowerCase().split(/\s+/).filter(Boolean);
	const groups: [string, SessionSummary[]][] = [];
	for (const session of sessions.value ?? []) {
		if (words.every(word => `${session.topic} ${session.summary}`.toLowerCase().includes(word))) {
			const label = ageLabel(session.createdAt);
			if (groups.at(-1)?.[0] === label) {
				groups.at(-1)![1].push(session);
			} else {
				groups.push([label, [session]]);
			}
		}
	}

	let content;
	if (page.name === 'settings') {
		content = <Settings />;
	} else if (!state.value) {
		content = state.error ? <Empty icon="error" title="Atelier could not start"><p>{state.error}</p></Empty> : null;
	} else if (!models.length) {
		content = (
			<Empty icon="sparkle" title="No AI model available">
				<p>Atelier plans, reads and writes with DataSuite's AI. Sign in to DataSuite (or add a model in the chat's model picker), then try again.</p>
				<button type="button" className="at-btn at-btn--primary" onClick={state.reload}><Icon name="refresh" /> Try again</button>
			</Empty>
		);
	} else if (page.name === 'home') {
		content = <Home state={state.value} model={chosen} setModel={setModel} open={id => setPage({ name: 'session', id })} />;
	} else if (page.name === 'history') {
		content = <History sessions={sessions.value ?? []} open={id => setPage({ name: 'session', id })} />;
	} else {
		content = <Feed key={page.id} sessionId={page.id} state={state.value} model={chosen} setModel={setModel}
			run={runs[page.id]} dismissRun={() => dismissRun(page.id)} open={id => setPage({ name: 'session', id })} deleted={() => setPage({ name: 'history' })} />;
	}

	return (
		<div className="at-app">
			<aside className="at-sidebar">
				<div className="at-brand"><Icon name="mortar-board" /><span>Atelier</span></div>
				<div className="at-panel">
					<button type="button" className="at-btn at-btn--primary at-panel__new" onClick={() => setPage({ name: 'home' })}><Icon name="add" /> New Search</button>
					<label className="at-panel__search">
						<Icon name="search" />
						<input type="text" value={find} onChange={e => setFind(e.target.value)} placeholder="Search sessions" aria-label="Search sessions" />
						{find && <button type="button" className="at-icon-btn" onClick={() => setFind('')} aria-label="Clear"><Icon name="close" /></button>}
					</label>
					<div className="at-panel__list">
						{groups.length === 0 && <p className="at-panel__none">{find ? 'No session has those words.' : 'Your sessions will be listed here.'}</p>}
						{groups.map(([label, list]) => (
							<div key={label} className="at-panel__group">
								<h3>{label}</h3>
								{list.map(session => {
									const working = !!runs[session.id] && !['failed', 'stopped'].includes(runs[session.id].phase);
									return (
										<button key={session.id} type="button" title={session.topic}
											className={`at-item${page.name === 'session' && page.id === session.id ? ' is-on' : ''}`}
											onClick={() => setPage({ name: 'session', id: session.id })}>
											<span className="at-item__tile"><Icon name={working ? 'loading' : 'book'} spin={working} /></span>
											<span className="at-item__text">
												<strong>{session.topic}</strong>
												<small><Icon name="comment" /> {new Date(session.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}{session.paperCount ? ` · ${session.paperCount} sources` : ''}</small>
											</span>
										</button>
									);
								})}
							</div>
						))}
					</div>
					<div className="at-panel__foot">
						<button type="button" className={`at-nav${page.name === 'history' ? ' is-on' : ''}`} onClick={() => setPage({ name: 'history' })}><Icon name="history" /> History</button>
						<button type="button" className={`at-nav${page.name === 'settings' ? ' is-on' : ''}`} onClick={() => setPage({ name: 'settings' })}><Icon name="settings-gear" /> Settings</button>
					</div>
				</div>
				{state.value && <div className="at-sidebar__foot">Atelier {state.value.version}</div>}
			</aside>
			<main className="at-main">{content}</main>
		</div>
	);
}

createRoot(document.getElementById('root')!).render(<App />);
