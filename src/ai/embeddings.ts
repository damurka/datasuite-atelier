/*---------------------------------------------------------------------------------------------
 *  Atelier: embeddings from DataSuite's AI service (google/gemini-embedding-2, 768 dimensions; datasuite
 *  docs/adr/0028) -- through the `datasuite.embeddings.compute` command, which tells a query from a document, or the
 *  proposed `vscode.lm.computeEmbeddings`. Both are optional: an older DataSuite, a signed-out user or
 *  `datasuite.embeddings.enabled: false` leave the ranking to keywords.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { normalize } from '../core/scoring';

const EXTENSION_ID = 'datasuite.atelier';
const COMMAND = 'datasuite.embeddings.compute';
const PROPOSED_MODEL = 'google/gemini-embedding-2-768';
/** The model the vectors are stored under (what the command answers with). */
export const EMBED_MODEL = 'google/gemini-embedding-2';
export const EMBED_DIMENSIONS = 768;
/** Inputs per call. The model takes at most 100 texts in one request, whatever the command itself accepts (1,024). */
const BATCH = 96;

export type EmbedFailure = { readonly ok: false; readonly reason: string; readonly message: string };
export type EmbedResult = { readonly ok: true; readonly model: string; readonly vectors: Float32Array[] } | EmbedFailure;

type ProposedLm = { computeEmbeddings?: typeof vscode.lm.computeEmbeddings; embeddingModels?: string[] };

function disabled(): boolean {
	return vscode.workspace.getConfiguration().get<boolean>('datasuite.embeddings.enabled') === false;
}

const OFF: EmbedFailure = { ok: false, reason: 'disabled', message: 'DataSuite embeddings are turned off (datasuite.embeddings.enabled).' };
const UNAVAILABLE: EmbedFailure = { ok: false, reason: 'unavailable', message: 'DataSuite embeddings are not available (an older DataSuite, or not signed in).' };

/** Whether embeddings can be asked for at all (nothing is sent to find out). */
export async function embeddingsStatus(): Promise<{ available: boolean; message?: string }> {
	if (disabled()) {
		return { available: false, message: OFF.message };
	}
	const commands = await vscode.commands.getCommands(true).then(all => all, () => [] as string[]);
	const lm = vscode.lm as unknown as ProposedLm;
	const available = commands.includes(COMMAND) || (typeof lm.computeEmbeddings === 'function' && (lm.embeddingModels ?? []).includes(PROPOSED_MODEL));
	return available ? { available } : { available, message: UNAVAILABLE.message };
}

/** Unit vectors of the texts. Never throws: `{ ok: false, reason }` when embeddings are off, signed out, over quota, etc. */
export async function embed(inputs: readonly string[], inputType: 'query' | 'document', token?: vscode.CancellationToken): Promise<EmbedResult> {
	if (disabled()) {
		return OFF;
	}
	if (!inputs.length) {
		return { ok: true, model: EMBED_MODEL, vectors: [] };
	}
	let failure: EmbedFailure = UNAVAILABLE;
	const commands = await vscode.commands.getCommands(true).then(all => new Set(all), () => new Set<string>());
	if (commands.has(COMMAND)) {
		const viaCommand = await embedWithCommand(inputs, inputType, token);
		// a DataSuite that doesn't know this extension yet answers `notAllowed`: the proposed API is tried
		if (viaCommand.ok || viaCommand.reason !== 'notAllowed') {
			return viaCommand;
		}
		failure = viaCommand;
	}
	try {
		const lm = vscode.lm as unknown as ProposedLm;
		if (typeof lm.computeEmbeddings !== 'function' || !(lm.embeddingModels ?? []).includes(PROPOSED_MODEL)) {
			return failure;
		}
		const vectors: Float32Array[] = [];
		for (let i = 0; i < inputs.length; i += BATCH) {
			const out = await lm.computeEmbeddings(PROPOSED_MODEL, inputs.slice(i, i + BATCH), token);
			vectors.push(...out.map(e => normalize(e.values)));
		}
		return { ok: true, model: EMBED_MODEL, vectors };
	} catch (error) {
		return { ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) };
	}
}

async function embedWithCommand(inputs: readonly string[], inputType: 'query' | 'document', token?: vscode.CancellationToken): Promise<EmbedResult> {
	const vectors: Float32Array[] = [];
	let model = EMBED_MODEL;
	for (let i = 0; i < inputs.length; i += BATCH) {
		if (token?.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		let reply: { ok: true; model: string; dimensions: number; vectors: number[][] } | EmbedFailure | undefined;
		try {
			reply = await vscode.commands.executeCommand(COMMAND, { extensionId: EXTENSION_ID, inputs: inputs.slice(i, i + BATCH), dimensions: EMBED_DIMENSIONS, inputType });
		} catch (error) {
			return { ok: false, reason: 'unavailable', message: error instanceof Error ? error.message : String(error) };
		}
		if (!reply || !reply.ok) {
			return reply ?? { ok: false, reason: 'unavailable', message: 'No answer from DataSuite embeddings.' };
		}
		model = reply.model || model;
		vectors.push(...reply.vectors.map(normalize));
	}
	return { ok: true, model, vectors };
}
