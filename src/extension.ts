/*---------------------------------------------------------------------------------------------
 *  Atelier: research synthesis in DataSuite. A question becomes database queries, the papers they return are ranked
 *  and read, and a cited summary is written.
 *
 *  The AI is DataSuite's: its chat models (vscode.lm) plan, read and write, and its embeddings rank the papers by
 *  meaning (proposal `embeddings`, or the `datasuite.embeddings.compute` command). The sign-in and the quota are the
 *  user's own in DataSuite; this extension holds no AI key.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { createHost } from './host';
import { AtelierPanel } from './panel';
import { BenchmarkResult, Pipeline } from './pipeline';
import { AtelierEvents, SessionSummary, Target } from './shared/api';
import { RpcEvent } from './shared/rpc';
import { AtelierStore } from './store';

export function activate(context: vscode.ExtensionContext): void {
	const log = vscode.window.createOutputChannel('Atelier', { log: true });
	const store = new AtelierStore(context.globalStorageUri.fsPath, log);
	const pipeline = new Pipeline(context, store, log);
	const events = new vscode.EventEmitter<RpcEvent>();
	const fire = <K extends keyof AtelierEvents>(name: K, data: AtelierEvents[K]) => events.fire({ kind: 'event', name, data });

	// Opens the app -- at a place, when one is asked for. A panel that is open already is told to go there; one that
	// is only now being made asks where to start once it is up.
	let pending: Target | undefined;
	const host = createHost(context, store, pipeline, () => { const at = pending; pending = undefined; return at; });
	const open = (target?: Target) => {
		const wasOpen = AtelierPanel.isOpen;
		pending = wasOpen ? undefined : target;
		AtelierPanel.show(context, host, events.event);
		if (wasOpen && target) {
			fire('navigate', target);
		}
	};

	// Ways in, beside the Command Palette: Atelier's own view in the side bar (the sessions, and Open Atelier when
	// there are none yet) and a button in the status bar
	const sessions = new SessionsView(store);
	const status = vscode.window.createStatusBarItem('atelier.open', vscode.StatusBarAlignment.Right, 90);
	status.name = 'Atelier';
	status.text = '$(mortar-board) Atelier';
	status.tooltip = 'Open Atelier: research synthesis';
	status.command = 'atelier.open';
	status.show();

	context.subscriptions.push(
		log,
		pipeline,
		store,
		events,
		pipeline.onDidChangeRun(run => fire('run', run)),
		store.onDidChangeSessions(() => fire('sessionsChanged', undefined)),
		// the models offered change with the sign-in; whether embeddings are on, with the setting
		vscode.lm.onDidChangeChatModels(() => fire('stateChanged', undefined)),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('datasuite.embeddings.enabled')) {
				fire('stateChanged', undefined);
			}
		}),
		vscode.commands.registerCommand('atelier.open', () => open()),
		vscode.commands.registerCommand('atelier.newSearch', () => open({ page: 'home' })),
		vscode.commands.registerCommand('atelier.openHistory', () => open({ page: 'history' })),
		vscode.commands.registerCommand('atelier.openSettings', () => open({ page: 'settings' })),
		vscode.commands.registerCommand('atelier.deleteSession', async (session: unknown) => {
			const id = typeof session === 'string' ? session : (session as SessionSummary | undefined)?.id;
			if (id) {
				await host.deleteSession(id);
			}
		}),
		vscode.commands.registerCommand('atelier.openSession', (id: unknown) => open(typeof id === 'string' ? { page: 'session', id } : undefined)),
		vscode.window.registerTreeDataProvider('atelier.sessions', sessions),
		store.onDidChangeSessions(() => sessions.refresh()),
		status,
		vscode.commands.registerCommand('atelier.setApiKey', () => open({ page: 'settings' })),
		vscode.commands.registerCommand('atelier.runBenchmark', () => runBenchmark(context, pipeline))
	);
}

/** The sessions in Atelier's side bar view, newest first: one opens the app at it. */
class SessionsView implements vscode.TreeDataProvider<SessionSummary> {

	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly store: AtelierStore) { }

	refresh(): void {
		this.changed.fire();
	}

	getChildren(element?: SessionSummary): SessionSummary[] {
		return element ? [] : this.store.listSessions();
	}

	getTreeItem(session: SessionSummary): vscode.TreeItem {
		const item = new vscode.TreeItem(session.topic);
		item.id = session.id;
		item.description = new Date(session.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		item.tooltip = new vscode.MarkdownString(`**${session.topic}**\n\n${session.summary || '_No synthesis yet._'}\n\n${session.queryCount} ${session.queryCount === 1 ? 'query' : 'queries'} · ${session.paperCount} ${session.paperCount === 1 ? 'source' : 'sources'}`);
		item.iconPath = new vscode.ThemeIcon('comment-discussion');
		item.contextValue = 'session';
		item.command = { command: 'atelier.openSession', title: 'Open in Atelier', arguments: [session.id] };
		return item;
	}
}

const BENCHMARK_TEMPLATE = `[
	{
		"question": "A research question you know the literature of",
		"expected": ["10.xxxx/the-doi-of-a-paper-that-should-come-back", "10.xxxx/another"]
	}
]
`;

/** The benchmark's results as a report: for each question, where each expected paper came in the ranking. */
export function benchmarkReport(results: readonly BenchmarkResult[], model: string): string {
	const within = (n: number) => results.reduce((sum, result) => sum + result.expected.filter(paper => paper.rank !== undefined && paper.rank <= n).length, 0);
	const expected = results.reduce((sum, result) => sum + result.expected.length, 0);
	const found = results.reduce((sum, result) => sum + result.expected.filter(paper => paper.rank !== undefined).length, 0);
	const share = (n: number) => expected ? `${n} of ${expected} (${Math.round(n / expected * 100)}%)` : '-';
	const lines = [
		'# Atelier ranking benchmark', '',
		`${new Date().toLocaleString()} · model: ${model} · ${results.length} question${results.length === 1 ? '' : 's'}`, '',
		'| Expected papers | |', '| --- | --- |',
		`| Found by the search at all | ${share(found)} |`,
		`| Ranked in the top 20 (what is read first) | ${share(within(20))} |`,
		`| Ranked in the top 60 (the most that is read) | ${share(within(60))} |`, ''
	];
	for (const result of results) {
		lines.push(`## ${result.question}`, '', `${result.candidates} candidates · ranked by ${result.ranking === 'embeddings' ? 'meaning and keywords' : 'keywords'} · ${result.seconds} s`, '', '| Expected paper | Rank | Screening |', '| --- | --- | --- |');
		for (const paper of result.expected) {
			lines.push(`| ${paper.doi} | ${paper.rank ?? 'not found'} | ${paper.screened ?? '-'} |`);
		}
		lines.push('');
	}
	lines.push('A paper "not found" never entered the pool: no database returned it and the citation trail did not reach it. One found but ranked low was rated low by the screening (the last column) or is far from the question in meaning.', '');
	return lines.join('\n');
}

/**
 * Measures the search and ranking on questions whose answers are known: \`benchmark.json\` in Atelier's storage lists
 * questions with the DOIs that should come back. Without the file, a template is made and opened to fill in.
 */
async function runBenchmark(context: vscode.ExtensionContext, pipeline: Pipeline): Promise<void> {
	const file = path.join(context.globalStorageUri.fsPath, 'benchmark.json');
	const edit = async () => { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file)); };
	if (!fs.existsSync(file)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, BENCHMARK_TEMPLATE);
		await edit();
		void vscode.window.showInformationMessage('List questions and the DOIs of papers each should bring back, save, then run the benchmark again.');
		return;
	}
	let questions: { question: string; expected: string[] }[];
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
		questions = (Array.isArray(parsed) ? parsed : []).filter(q => typeof q?.question === 'string' && Array.isArray(q?.expected)).map(q => ({ question: String(q.question), expected: (q.expected as unknown[]).map(String).filter(doi => !doi.includes('xxxx')) })).filter(q => q.expected.length);
	} catch (error) {
		void vscode.window.showErrorMessage(`benchmark.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
		await edit();
		return;
	}
	if (!questions.length) {
		await edit();
		void vscode.window.showInformationMessage('benchmark.json has no question with expected DOIs yet.');
		return;
	}
	const models = await vscode.lm.selectChatModels();
	const saved = context.globalState.get<string>('atelier.model');
	const model = models.find(m => m.id === saved) ?? models[0];
	if (!model) {
		void vscode.window.showErrorMessage('No AI model is available: sign in to DataSuite first.');
		return;
	}
	try {
		const results = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Atelier benchmark', cancellable: true }, (progress, token) =>
			pipeline.benchmark(questions, model.id, token, (done, question) => progress.report({ message: `${done + 1} of ${questions.length}: ${question}`, increment: done ? 100 / questions.length : 0 })));
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'markdown', content: benchmarkReport(results, model.name) }));
	} catch (error) {
		if (!(error instanceof vscode.CancellationError)) {
			void vscode.window.showErrorMessage(`The benchmark stopped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export function deactivate(): void {
	// The panel, the store and a running query are in the context's subscriptions: the query stops, what was read is saved
}
