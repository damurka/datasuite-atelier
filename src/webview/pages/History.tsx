/*---------------------------------------------------------------------------------------------
 *  Atelier: every Session, newest first, by day.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { SessionSummary } from '../../shared/api';
import { Empty, ErrorLine, Icon } from '../components';
import { dayLabel, host, timeLabel, useAction } from '../hooks';

export function History({ sessions, open }: { sessions: readonly SessionSummary[]; open: (sessionId: string) => void }) {
	const [filter, setFilter] = useState('');
	const [run, error, , dismiss] = useAction();
	const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
	const shown = sessions.filter(session => words.every(word => `${session.topic} ${session.summary}`.toLowerCase().includes(word)));
	const days: [string, SessionSummary[]][] = [];
	for (const session of shown) {
		const day = dayLabel(session.createdAt);
		if (days.at(-1)?.[0] === day) {
			days.at(-1)![1].push(session);
		} else {
			days.push([day, [session]]);
		}
	}
	return (
		<div className="at-page">
			<h1>History</h1>
			<label className="at-filter">
				<Icon name="filter" />
				<input type="text" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter through your past insights..." />
			</label>
			<ErrorLine error={error} onDismiss={dismiss} />
			{sessions.length === 0 && <Empty icon="history" title="No sessions yet"><p>Every question you research is kept here, with its papers and summaries.</p></Empty>}
			{sessions.length > 0 && shown.length === 0 && <Empty icon="search" title="Nothing matches"><p>No session's topic or summary has those words.</p></Empty>}
			{days.map(([day, list]) => (
				<section key={day} className="at-day">
					<h2 className="at-day__label"><span>{day}</span></h2>
					{list.map(session => (
						<div key={session.id} className="at-session" role="button" tabIndex={0}
							onClick={() => open(session.id)} onKeyDown={e => { if (e.key === 'Enter') { open(session.id); } }}>
							<div className="at-session__head">
								<h3>{session.topic}</h3>
								<span className="at-session__time">{timeLabel(session.createdAt)}</span>
							</div>
							{session.summary && <p className="at-session__summary">{session.summary}</p>}
							<div className="at-session__meta">
								<span><Icon name="comment-discussion" /> {session.queryCount} {session.queryCount === 1 ? 'query' : 'queries'}</span>
								<span><Icon name="book" /> {session.paperCount} {session.paperCount === 1 ? 'source' : 'sources'}</span>
								<button type="button" className="at-icon-btn at-session__delete" title="Delete this session" aria-label="Delete this session"
									onClick={e => { e.stopPropagation(); void run(() => host.deleteSession(session.id)); }}><Icon name="trash" /></button>
							</div>
						</div>
					))}
				</section>
			))}
		</div>
	);
}
