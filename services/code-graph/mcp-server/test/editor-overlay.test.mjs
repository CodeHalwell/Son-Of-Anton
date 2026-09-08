/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { EditorOverlay, dependencyImpact } from '../dist/editorOverlay.js';

test('unsaved snapshots replace stale search hits and outlines without touching saved source', async t => {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-overlay-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = path.join(root, 'source.ts'); await writeFile(file, 'export function oldName() {}');
	const filename = await realpath(file), overlay = new EditorOverlay(root), text = 'export function newName() { return "new database"; }';
	const document = { path: file, text, version: 2, language: 'typescript', outlineAvailable: true, symbols: [{ name: 'newName', kind: 'Function', start: 0, end: Buffer.byteLength(text) }] };
	assert.equal(overlay.apply({ workspace: root, revision: 1, documents: [document] }), true);
	const engine = { fileSummary: () => ({ path: file, language: 'typescript', symbols: [{ name: 'oldName' }] }), symbolLookup: () => [{ name: 'oldName', file, kind: 'Function', start: 0, end: 26 }] };
	assert.deepEqual([overlay.fileSummary(engine, file).symbols[0].name, overlay.symbolLookup(engine, 'oldName', 10), overlay.search('database', [{ file, symbol: 'oldName', kind: 'Function', snippet: 'stale', score: 1 }], 10).map(hit => [hit.file, hit.symbol, hit.retrieval, hit.documentVersion]), await readFile(file, 'utf8')], ['newName', [], [[filename, 'newName', 'local-text-match', 2]], 'export function oldName() {}']);
	assert.equal(overlay.apply({ workspace: root, revision: 0, documents: [] }), false);
	assert.equal(overlay.apply({ workspace: root, revision: 2, documents: [{ ...document, version: 1 }] }), false);
	assert.equal(overlay.apply({ workspace: root, revision: 3, documents: [] }), true);
	assert.equal(overlay.fileSummary(engine, file).symbols[0].name, 'oldName');
});

test('overlay rejects cross-workspace, escaping paths and oversized snapshots atomically', () => {
	const overlay = new EditorOverlay('/workspace');
	const document = { path: '/workspace/file.ts', version: 1, text: 'abc', language: 'typescript', outlineAvailable: false, symbols: [] };
	for (const snapshot of [{ workspace: '/elsewhere', revision: 1, documents: [document] }, { workspace: '/workspace', revision: 1, documents: [{ ...document, path: '../secrets.ts' }] }, { workspace: '/workspace', revision: 1, documents: [{ ...document, text: 'x'.repeat(256 * 1024 + 1) }] }]) { assert.equal(overlay.apply(snapshot), false); }
	assert.equal(overlay.size, 0);
});

test('dependency impact preserves intermediate callers and terminates cycles', () => {
	const graph = new Map([['target.ts', ['caller.ts']], ['caller.ts', ['test.ts', 'target.ts']], ['test.ts', []]]);
	const result = dependencyImpact({ impactAnalysis: file => graph.get(file) ?? [] }, 'target.ts', 3);
	assert.deepEqual(result, { fileBased: true, paths: [['caller.ts', 'target.ts'], ['test.ts', 'caller.ts', 'target.ts']], truncated: false });
});

test('live MCP notification changes retrieval and removes overlay on save without adding a model-callable mutation tool', { timeout: 15000 }, async t => {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
	const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
	const root = await mkdtemp(path.join(tmpdir(), 'sota-live-overlay-'));
	const source = path.join(root, 'source.ts'), native = path.join(root, 'native.cjs');
	await writeFile(source, 'export const saved = 1;');
	await writeFile(native, `module.exports = { init() {}, async indexWorkspace() { return { files: 1, symbols: 1, edges: 0, skippedUnchanged: 0 }; }, fileSummary(path) { return { path, language: 'typescript', symbols: [{ name: 'saved', kind: 'Constant', start: 0, end: 23 }] }; }, symbolLookup() { return []; }, dependencyTraversal() { return []; }, impactAnalysis() { return []; }, findReferences() { return []; } };`);
	const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../dist/index.js', import.meta.url).pathname, `--db=${path.join(root, 'graph.db')}`, `--index-root=${root}`], env: { ...process.env, CODEGRAPH_NAPI_PATH: native }, stderr: 'pipe' });
	const client = new Client({ name: 'overlay-test', version: '1' });
	t.after(async () => { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	await client.connect(transport);
	for (let i = 0; i < 50; i++) {
		const result = await client.callTool({ name: 'codegraph_status', arguments: {} });
		if (JSON.parse(result.content[0].text).structural) { break; }
		await new Promise(resolve => setTimeout(resolve, 40));
	}
	const text = 'export const unsaved = 2;';
	await client.notification({ method: 'notifications/son-of-anton/editor-overlay', params: { workspace: root, revision: 1, documents: [{ path: source, version: 2, language: 'typescript', text, outlineAvailable: true, symbols: [{ name: 'unsaved', kind: 'Constant', start: 0, end: text.length }] }] } });
	const outline = await client.callTool({ name: 'file_summary', arguments: { path: source } });
	const search = await client.callTool({ name: 'semantic_search', arguments: { query: 'unsaved' } });
	const tools = await client.listTools();
	assert.deepEqual([JSON.parse(outline.content[0].text).symbols[0].name, JSON.parse(search.content[0].text)[0].retrieval, tools.tools.some(tool => /overlay/.test(tool.name)), await readFile(source, 'utf8')], ['unsaved', 'local-text-match', false, 'export const saved = 1;']);
	await client.notification({ method: 'notifications/son-of-anton/editor-overlay', params: { workspace: root, revision: 2, documents: [] } });
	const restored = await client.callTool({ name: 'file_summary', arguments: { path: source } });
	assert.equal(JSON.parse(restored.content[0].text).symbols[0].name, 'saved');
});
