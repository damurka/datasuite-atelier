// Builds the extension (Node, CommonJS, for the extension host) and its webview (React, for the browser), each into one
// file. fast-xml-parser and marked are bundled too: the .vsix ships no node_modules.
//
//   node esbuild.mjs            build once (minified)
//   node esbuild.mjs --watch    rebuild on change (unminified, with source maps)

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions[]} */
const builds = [
	{
		entryPoints: ['src/extension.ts'],
		outfile: 'out/extension.js',
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'node22',
		external: ['vscode'],
	},
	{
		entryPoints: ['src/webview/main.tsx'],
		outfile: 'out/webview.js',
		bundle: true,
		platform: 'browser',
		format: 'iife',
		target: 'chrome130',
		jsx: 'automatic',
		// the codicon font, emitted next to webview.css and referenced from it
		loader: { '.css': 'css', '.ttf': 'file' },
		assetNames: '[name]-[hash]',
	},
];

// what earlier builds emitted (renamed assets) is not left next to this build's
if (!watch) {
	fs.rmSync('out', { recursive: true, force: true });
}

for (const options of builds) {
	const config = { ...options, minify: !watch, sourcemap: watch ? 'inline' : false, logLevel: 'info', define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' } };
	if (watch) {
		await (await esbuild.context(config)).watch();
	} else {
		await esbuild.build(config);
	}
}
