/*---------------------------------------------------------------------------------------------
 *  Atelier: the host's methods, as the webview calls them (shared/api.ts).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { embeddingsStatus } from './ai/embeddings';
import { API_KEY_SECRETS, Pipeline } from './pipeline';
import { citationStyle } from './core/cite';
import { queryPdf, referencesBibtex, referencesRis, referencesText, tablesCsv } from './export';
import { ApiKeyName, AtelierHost, DownloadKind, ModelInfo, Query, SettingName, Settings, Source, Target } from './shared/api';
import { AtelierStore } from './store';

const MODEL_KEY = 'atelier.model';
/** Where the last download was saved: the next is offered there. */
const FOLDER_KEY = 'atelier.downloadFolder';

async function listModels(): Promise<ModelInfo[]> {
	const models = await vscode.lm.selectChatModels().then(all => all, () => []);
	return models.map(model => ({ id: model.id, name: model.name, vendor: model.vendor, family: model.family }));
}

const csvCell = (value: unknown) => {
	const text = value === undefined || value === null ? '' : String(value);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** A Query's papers, one a row, with what was extracted from each. */
export function queryCsv(query: Query): string {
	const header = ['#', 'Title', 'Authors', 'Year', 'Journal', 'Study type', 'Citations', 'DOI', 'PMID', 'PMCID', 'Link', 'Score', 'Relevance', 'Answer', 'Population', 'Methods', 'Results', 'Outcomes', 'Sample size', 'Studies included', 'Duration', 'Country', 'Stance', 'Full text read', 'Abstract overstates', 'Journal citations per paper (2 yr)', 'Open-access PDF', 'Found in'];
	const rows = query.papers.map((paper, i) => [
		i + 1, paper.title, paper.authors.join('; '), paper.year, paper.journal, paper.studyType, paper.citationCount, paper.doi, paper.pmid, paper.pmcid,
		paper.doi ? `https://doi.org/${paper.doi}` : paper.fullTextUrl ?? paper.pdfUrl, paper.score, paper.extraction?.relevance,
		paper.extraction?.answer, paper.extraction?.population, paper.extraction?.methods, paper.extraction?.results, paper.extraction?.outcomes,
		paper.extraction?.sampleSize, paper.extraction?.studyCount, paper.extraction?.duration, paper.extraction?.country, paper.extraction?.stance,
		paper.extraction?.fullText ? 'yes' : 'no', paper.extraction?.misleadingAbstract ? paper.extraction.fidelity ?? 'yes' : '', paper.journalImpact, paper.pdfUrl, paper.sources.join('; ')
	]);
	// the BOM tells Excel the file is UTF-8
	return '﻿' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** What each download is saved as. */
const DOWNLOADS: Record<DownloadKind, { suffix: string; extension: string; filter: string }> = {
	pdf: { suffix: '', extension: 'pdf', filter: 'PDF' },
	tables: { suffix: '-tables', extension: 'csv', filter: 'CSV' },
	papers: { suffix: '-papers', extension: 'csv', filter: 'CSV' },
	references: { suffix: '-references', extension: 'txt', filter: 'Text' },
	ris: { suffix: '-references', extension: 'ris', filter: 'RIS (Zotero, EndNote, Mendeley)' },
	bibtex: { suffix: '-references', extension: 'bib', filter: 'BibTeX' }
};

/** The settings the app changes, and the limits a number is kept within (package.json's). */
const SETTING_LIMITS: Record<SettingName, [number, number] | undefined> = {
	maxResultsPerSource: [5, 100], referencesWanted: [1, 50], papersToRead: [1, 200], readFullText: undefined, contactEmail: undefined, citationStyle: undefined, workModel: undefined, databases: undefined, followCitations: undefined
};

/** The databases a search can ask; all but arXiv unless the setting says otherwise. */
const DATABASES: readonly Source[] = ['pubmed', 'europepmc', 'openalex', 'semanticscholar', 'crossref', 'core', 'arxiv'];

/** Asks before deleting: answers whether the user said to. */
async function confirmDelete(message: string, detail: string, action: string): Promise<boolean> {
	return await vscode.window.showWarningMessage(message, { modal: true, detail }, action) === action;
}

export function createHost(context: vscode.ExtensionContext, store: AtelierStore, pipeline: Pipeline, takeNavigation: () => Target | undefined): AtelierHost {
	const settings = async (): Promise<Settings> => {
		const config = vscode.workspace.getConfiguration('atelier');
		const has = async (name: ApiKeyName) => !!(await context.secrets.get(API_KEY_SECRETS[name]));
		return {
			maxResultsPerSource: config.get<number>('maxResultsPerSource') ?? 50,
			referencesWanted: config.get<number>('referencesWanted') ?? 20,
			papersToRead: config.get<number>('papersToRead') ?? 60,
			readFullText: config.get<boolean>('readFullText') !== false,
			contactEmail: config.get<string>('contactEmail') ?? '',
			citationStyle: citationStyle(config.get('citationStyle')),
			workModel: config.get<string>('workModel') ?? '',
			databases: (config.get<string[]>('databases') ?? DATABASES.filter(source => source !== 'arxiv')).filter((source): source is Source => (DATABASES as readonly string[]).includes(source)),
			followCitations: config.get<boolean>('followCitations') !== false,
			keys: { semanticScholar: await has('semanticScholar'), ncbi: await has('ncbi'), openAlex: await has('openAlex'), core: await has('core') },
			stored: store.stats()
		};
	};
	return {
		getSettings: settings,
		updateSetting: async (name, value) => {
			if (!Object.prototype.hasOwnProperty.call(SETTING_LIMITS, name)) {
				throw new Error(`Unknown setting ${name}`);
			}
			const limits = SETTING_LIMITS[name];
			let kept: number | boolean | string | string[];
			if (limits) {
				const n = Math.round(Number(value));
				if (!Number.isFinite(n)) {
					throw new Error('That is not a number.');
				}
				kept = Math.max(limits[0], Math.min(limits[1], n));
			} else if (name === 'readFullText' || name === 'followCitations') {
				kept = value === true;
			} else if (name === 'databases') {
				kept = DATABASES.filter(source => Array.isArray(value) && value.includes(source));
				if (!kept.length) {
					throw new Error('A search needs at least one database.');
				}
			} else if (name === 'workModel') {
				kept = String(value ?? '').trim();
			} else if (name === 'citationStyle') {
				kept = citationStyle(value);
			} else {
				kept = String(value ?? '').trim();
				if (kept && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(kept)) {
					throw new Error('That does not look like an email address.');
				}
			}
			await vscode.workspace.getConfiguration('atelier').update(name, kept, vscode.ConfigurationTarget.Global);
			return settings();
		},
		setApiKey: async (name, key) => {
			const secret = Object.prototype.hasOwnProperty.call(API_KEY_SECRETS, name) ? API_KEY_SECRETS[name] : undefined;
			if (!secret) {
				throw new Error(`Unknown database ${name}`);
			}
			if (typeof key === 'string' && key.trim()) {
				await context.secrets.store(secret, key.trim());
			} else {
				await context.secrets.delete(secret);
			}
			return settings();
		},
		deleteData: async what => {
			const stored = store.stats();
			const everything = what === 'everything';
			const sure = await confirmDelete(
				everything ? 'Delete everything Atelier keeps on this computer?' : `Delete all ${stored.sessions} sessions?`,
				everything ? `${stored.sessions} sessions and ${stored.papers} papers, with their embeddings and what the AI read from them. Settings and API keys stay. This cannot be undone.` : 'Their questions, summaries and reference lists. The papers themselves stay, for later searches to recall. This cannot be undone.',
				everything ? 'Delete Everything' : 'Delete All Sessions');
			if (!sure) {
				return false;
			}
			pipeline.stopAll();
			if (everything) {
				store.deleteEverything();
			} else {
				store.deleteAllSessions();
			}
			return true;
		},
		getState: async () => {
			const models = await listModels();
			const saved = context.globalState.get<string>(MODEL_KEY);
			return {
				models,
				model: models.some(model => model.id === saved) ? saved : undefined,
				embeddings: await embeddingsStatus(),
				version: String(context.extension.packageJSON.version)
			};
		},
		listSessions: async () => store.listSessions(),
		getSession: async id => store.getSession(id),
		deleteSession: async id => {
			const session = store.getSession(id);
			if (!session || !await confirmDelete('Delete this session?', `"${session.topic}"\n\nIts ${session.queryCount} ${session.queryCount === 1 ? 'query' : 'queries'}, summaries and reference lists. This cannot be undone.`, 'Delete Session')) {
				return false;
			}
			pipeline.stop(id);
			store.deleteSession(id);
			return true;
		},
		listRuns: async () => pipeline.listRuns(),
		ask: async (sessionId, prompt, model, selected) => {
			void context.globalState.update(MODEL_KEY, model);
			return pipeline.ask(sessionId, prompt, model, selected);
		},
		stop: async sessionId => pipeline.stop(sessionId),
		rate: async (sessionId, fingerprint, value) => store.setFeedback(sessionId, String(fingerprint), value === 1 ? 1 : value === -1 ? -1 : 0),
		summarizePaper: (sessionId, fingerprint, model) => pipeline.summarizePaper(sessionId, fingerprint, model),
		download: async (sessionId, queryId, kind, options) => {
			const query = store.getQuery(sessionId, queryId);
			const as = DOWNLOADS[kind];
			const style = citationStyle(vscode.workspace.getConfiguration('atelier').get('citationStyle'));
			if (!query || !as) {
				throw new Error('That query is no longer in the session.');
			}
			const name = (query.searchQuery ?? query.prompt).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'atelier';
			const folder = context.globalState.get<string>(FOLDER_KEY) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(os.homedir(), 'Documents');
			const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder, `${name}${as.suffix}.${as.extension}`)), filters: { [as.filter]: [as.extension] } });
			if (!target) {
				return undefined;
			}
			const content = kind === 'pdf' ? await queryPdf(query, store.getSession(sessionId)?.topic ?? query.prompt, { ...options, style })
				: kind === 'tables' ? tablesCsv(query)
					: kind === 'papers' ? queryCsv(query)
						: kind === 'ris' ? referencesRis(query)
							: kind === 'bibtex' ? referencesBibtex(query)
								: referencesText(query, style);
			fs.writeFileSync(target.fsPath, content);
			void context.globalState.update(FOLDER_KEY, path.dirname(target.fsPath));
			// saved: offer to open it, without holding up the app
			void vscode.window.showInformationMessage(`Saved ${path.basename(target.fsPath)}`, 'Open', 'Show in Folder').then(choice => {
				if (choice === 'Open') {
					void vscode.env.openExternal(target);
				} else if (choice === 'Show in Folder') {
					void vscode.commands.executeCommand('revealFileInOS', target);
				}
			});
			return target.fsPath;
		},
		takeNavigation: async () => takeNavigation(),
		openLink: async url => {
			if (/^https?:\/\//i.test(url)) {
				await vscode.env.openExternal(vscode.Uri.parse(url, true));
			}
		},
		copy: async text => vscode.env.clipboard.writeText(text)
	};
}
