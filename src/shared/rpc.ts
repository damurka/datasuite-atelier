/*---------------------------------------------------------------------------------------------
 *  Atelier: the messages between the webview (React) and the extension host.
 *
 *  The webview calls the host's methods by name ({@link RpcRequest}) and awaits the result ({@link RpcResponse}); the
 *  host pushes events ({@link RpcEvent}). Everything that touches the network, the AI, the disk or VS Code runs in the host: the
 *  webview only shows and asks. Shared by both sides (types only, no imports of vscode or the DOM).
 *--------------------------------------------------------------------------------------------*/

/** An object whose own methods the webview may call (each returns a promise). */
export type HostMethods = object;

export interface RpcRequest {
	readonly kind: 'request';
	readonly id: number;
	readonly method: string;
	readonly args: unknown[];
}

export interface RpcResponse {
	readonly kind: 'response';
	readonly id: number;
	readonly result?: unknown;
	/** The error's message when the call failed. */
	readonly error?: string;
}

export interface RpcEvent {
	readonly kind: 'event';
	readonly name: string;
	readonly data: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcEvent;

export function isRpcMessage(value: unknown): value is RpcMessage {
	const kind = (value as { kind?: unknown } | undefined)?.kind;
	return kind === 'request' || kind === 'response' || kind === 'event';
}
