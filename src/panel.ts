/*---------------------------------------------------------------------------------------------
 *  Atelier: the editor panel, a webview running the React app (out/webview.js), and the dispatch of its calls to the
 *  host's methods.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { HostMethods, isRpcMessage, RpcEvent, RpcResponse } from './shared/rpc';

export class AtelierPanel implements vscode.Disposable {

	static readonly viewType = 'atelier.panel';
	private static current: AtelierPanel | undefined;

	static get isOpen(): boolean {
		return !!AtelierPanel.current;
	}

	/** Opens the panel, or shows it when it is open already. */
	static show(context: vscode.ExtensionContext, methods: HostMethods, events: vscode.Event<RpcEvent>): AtelierPanel {
		if (AtelierPanel.current) {
			AtelierPanel.current.panel.reveal();
			return AtelierPanel.current;
		}
		const panel = vscode.window.createWebviewPanel(AtelierPanel.viewType, 'Atelier', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out'), vscode.Uri.joinPath(context.extensionUri, 'media')]
		});
		panel.iconPath = { light: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-light.svg'), dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'icon-dark.svg') };
		AtelierPanel.current = new AtelierPanel(panel, context, methods, events);
		return AtelierPanel.current;
	}

	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		private readonly methods: HostMethods,
		events: vscode.Event<RpcEvent>
	) {
		panel.webview.html = this.html(context);
		this.disposables.push(
			panel.webview.onDidReceiveMessage(message => this.onMessage(message)),
			events(event => void panel.webview.postMessage(event)),
			panel.onDidDispose(() => this.dispose())
		);
	}

	dispose(): void {
		AtelierPanel.current = undefined;
		for (const d of this.disposables.splice(0)) {
			d.dispose();
		}
	}

	private async onMessage(message: unknown): Promise<void> {
		if (!isRpcMessage(message) || message.kind !== 'request') {
			return;
		}
		const own = Object.prototype.hasOwnProperty.call(this.methods, message.method) ? (this.methods as Record<string, unknown>)[message.method] : undefined;
		const method = typeof own === 'function' ? own as (...args: unknown[]) => Promise<unknown> : undefined;
		let response: RpcResponse;
		try {
			if (!method) {
				throw new Error(`Unknown method ${message.method}`);
			}
			response = { kind: 'response', id: message.id, result: await method(...(Array.isArray(message.args) ? message.args : [])) };
		} catch (error) {
			response = { kind: 'response', id: message.id, error: error instanceof Error ? error.message : String(error) };
		}
		await this.panel.webview.postMessage(response);
	}

	private html(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const nonce = randomBytes(16).toString('base64');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview.css'));
		// Nothing remote: the app's own script, styles and icon font, and no connections of its own (the databases and
		// the AI are asked by the host)
		const csp = [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}'`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`img-src ${webview.cspSource} data:`,
			`font-src ${webview.cspSource}`
		].join('; ');
		return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
	<title>Atelier</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
