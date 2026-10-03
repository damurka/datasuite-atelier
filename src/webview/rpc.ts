/*---------------------------------------------------------------------------------------------
 *  Atelier: the webview's side of the messages (see shared/rpc.ts) -- calls to the host and its events.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { HostMethods, isRpcMessage, RpcRequest } from '../shared/rpc';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Map<string, Set<(data: unknown) => void>>();

window.addEventListener('message', event => {
	const message = event.data;
	if (!isRpcMessage(message)) {
		return;
	}
	if (message.kind === 'response') {
		const call = pending.get(message.id);
		pending.delete(message.id);
		if (message.error !== undefined) {
			call?.reject(new Error(message.error));
		} else {
			call?.resolve(message.result);
		}
	} else if (message.kind === 'event') {
		listeners.get(message.name)?.forEach(listener => listener(message.data));
	}
});

/** A proxy of the host's methods: `host.listSessions()` posts the call and resolves with its result. */
export function hostProxy<T extends HostMethods>(): T {
	return new Proxy({}, {
		get: (_target, method: string) => (...args: unknown[]) => new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			vscode.postMessage({ kind: 'request', id, method, args } satisfies RpcRequest);
		})
	}) as T;
}

export function onHostEvent<T>(name: string, listener: (data: T) => void): () => void {
	const set = listeners.get(name) ?? new Set();
	listeners.set(name, set);
	set.add(listener as (data: unknown) => void);
	return () => set.delete(listener as (data: unknown) => void);
}

/** A host event's latest data, in a React component. */
export function useHostEvent<T>(name: string, initial: T): T {
	const [value, setValue] = useState(initial);
	useEffect(() => onHostEvent<T>(name, setValue), [name]);
	return value;
}

/** What the webview keeps across being hidden and shown (VS Code's webview state). */
export const viewState = {
	get<T>(): T | undefined { return vscode.getState() as T | undefined; },
	set<T>(state: T): void { vscode.setState(state); }
};
