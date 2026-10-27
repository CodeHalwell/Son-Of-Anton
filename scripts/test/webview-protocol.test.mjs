/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = await readFile(new URL('../../src/vs/platform/webview/electron-main/webviewProtocolProvider.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;

function createHandler(readFile) {
	let handler, disposed = false;
	const exports = {};
	vm.runInNewContext(compiled, { exports, Response, Uint8Array, require: name => {
		if (name === 'electron') { return { protocol: { handle: (_scheme, callback) => { handler = callback; }, unhandle: () => { disposed = true; } } }; }
		if (name.endsWith('/network.js')) { return { Schemas: { vscodeWebview: 'vscode-webview' }, FileAccess: { asFileUri: value => value }, COI: { getHeadersFromQuery: () => ({}) } }; }
		if (name.endsWith('/uri.js')) { return { URI: { parse: value => ({ path: new URL(value).pathname }) } }; }
		if (name.endsWith('/files.js')) { return { IFileService: () => {} }; }
		throw new Error(`Unexpected import: ${name}`);
	} });
	const provider = new exports.WebviewProtocolProvider({ readFile });
	return { request: url => handler({ url: `vscode-webview://fixture${url}` }), dispose: () => { provider.dispose(); assert.equal(disposed, true); } };
}

for (const offset of [0, 2200]) {
	test(`webview response preserves exact bytes from a pooled allocation at offset ${offset}`, async () => {
		const payload = Buffer.from('self.addEventListener("fetch", () => {});');
		const allocation = Buffer.alloc(65536, 0xff);
		payload.copy(allocation, offset);
		const provider = createHandler(async () => ({ value: { buffer: allocation.subarray(offset, offset + payload.length) } }));
		try {
			const response = await provider.request('/service-worker.js');
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('content-type'), 'application/javascript');
			assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
			assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
		} finally { provider.dispose(); }
	});
}

test('webview protocol rejects unknown paths and reports read failures', async () => {
	let reads = 0;
	const provider = createHandler(async () => { reads++; throw new Error('Unreadable'); });
	try {
		assert.equal((await provider.request('/private-file')).status, 403);
		assert.equal(reads, 0);
		assert.equal((await provider.request('/index.html')).status, 500);
		assert.equal(reads, 1);
	} finally { provider.dispose(); }
});
