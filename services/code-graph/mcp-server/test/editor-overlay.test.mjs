/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

test('dependency impact preserves both diamond edges while expanding the shared caller once', () => {
	const graph = new Map([['target.ts', ['a.ts', 'b.ts']], ['a.ts', ['c.ts', 'c.ts']], ['b.ts', ['c.ts']], ['c.ts', ['test.ts']], ['test.ts', []]]);
	const queried = [];
	const result = dependencyImpact({ impactAnalysis: (file, depth) => { queried.push([file, depth]); return graph.get(file) ?? []; } }, 'target.ts', 3);
	assert.deepEqual(result, { fileBased: true, paths: [['a.ts', 'target.ts'], ['b.ts', 'target.ts'], ['c.ts', 'a.ts', 'target.ts'], ['c.ts', 'b.ts', 'target.ts'], ['test.ts', 'c.ts', 'a.ts', 'target.ts']], truncated: false });
	assert.deepEqual(queried, [['target.ts', 1], ['a.ts', 1], ['b.ts', 1], ['c.ts', 1]]);
});

test('dependency impact excludes cyclic witnesses and does not query beyond the requested depth', () => {
	const graph = new Map([['target.ts', ['a.ts', 'b.ts', 'target.ts']], ['a.ts', ['c.ts', 'target.ts']], ['b.ts', ['c.ts', 'a.ts']], ['c.ts', ['a.ts', 'c.ts', 'd.ts']]]);
	const queried = [], engine = { impactAnalysis: file => { queried.push(file); return graph.get(file) ?? []; } };
	assert.deepEqual(dependencyImpact(engine, 'target.ts', 1), { fileBased: true, paths: [['a.ts', 'target.ts'], ['b.ts', 'target.ts']], truncated: false });
	assert.deepEqual(queried, ['target.ts']);
	queried.length = 0;
	const result = dependencyImpact(engine, 'target.ts', 3);
	assert.deepEqual(result.paths, [['a.ts', 'target.ts'], ['b.ts', 'target.ts'], ['c.ts', 'a.ts', 'target.ts'], ['c.ts', 'b.ts', 'target.ts'], ['a.ts', 'b.ts', 'target.ts'], ['d.ts', 'c.ts', 'a.ts', 'target.ts']]);
	assert.equal(result.paths.every(chain => new Set(chain).size === chain.length && chain.length <= 4), true);
	assert.deepEqual(queried, ['target.ts', 'a.ts', 'b.ts', 'c.ts']);
});

test('node limits still retain alternate edges among admitted files and flag only omitted nodes', () => {
	const direct = Array.from({ length: 199 }, (_, index) => `caller-${index}.ts`);
	const engine = { impactAnalysis: file => file === 'target.ts' ? direct : file === direct[0] ? [direct[1], 'omitted.ts'] : [] };
	const result = dependencyImpact(engine, 'target.ts', 2);
	assert.deepEqual([result.paths.length, result.paths.at(-1), result.truncated, new Set(result.paths.flat()).size], [200, [direct[1], direct[0], 'target.ts'], true, 200]);
	assert.equal(dependencyImpact(engine, 'target.ts', 1).truncated, false, 'Exactly reaching the node limit does not imply missing evidence');
});

test('dense graph output and duplicate-edge work are bounded with explicit truncation', () => {
	const files = Array.from({ length: 100 }, (_, index) => `file-${index}.ts`), queried = [];
	const result = dependencyImpact({ impactAnalysis: file => { queried.push(file); return files; } }, 'target.ts', 20);
	assert.deepEqual([result.paths.length, result.truncated, queried.length === new Set(queried).size, queried.length <= 200], [1000, true, true, true]);
	const duplicates = dependencyImpact({ impactAnalysis: () => Array(10_001).fill('caller.ts') }, 'target.ts', 1);
	assert.deepEqual(duplicates, { fileBased: true, paths: [['caller.ts', 'target.ts']], truncated: true });
});

test('live MCP notification changes retrieval and removes overlay on save without adding a model-callable mutation tool', { timeout: 15000 }, async t => {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
	const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
	const root = await mkdtemp(path.join(tmpdir(), 'sota-live-overlay-'));
	const source = path.join(root, 'source.ts'), native = path.join(root, 'native.cjs');
	await writeFile(source, 'export const saved = 1;');
	await writeFile(native, `module.exports = { init() {}, async indexWorkspace() { return { files: 1, symbols: 1, edges: 0, skippedUnchanged: 0 }; }, fileSummary(path) { return { path, language: 'typescript', symbols: [{ name: 'saved', kind: 'Constant', start: 0, end: 23 }] }; }, symbolLookup() { return []; }, dependencyTraversal() { return []; }, impactAnalysis() { return []; }, findReferences() { return []; } };`);
	const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), `--db=${path.join(root, 'graph.db')}`, `--index-root=${root}`], env: { ...process.env, CODEGRAPH_NAPI_PATH: native }, stderr: 'pipe' });
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

test('live impact command preserves diamond evidence, native flat results and overlay freshness', { timeout: 15000 }, async t => {
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
	const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
	const root = await realpath(await mkdtemp(path.join(tmpdir(), 'sota-live-impact-')));
	const [target, a, b, c] = ['target.ts', 'a.ts', 'b.ts', 'c.ts'].map(name => path.join(root, name));
	for (const filename of [target, a, b, c]) { await writeFile(filename, 'export const saved = 1;'); }
	const graph = { [target]: [a, b], [a]: [c], [b]: [c], [c]: [] }, native = path.join(root, 'native.cjs');
	await writeFile(native, `const graph = ${JSON.stringify(graph)}; module.exports = { init() {}, async indexWorkspace() { return { files: 4, symbols: 4, edges: 4, skippedUnchanged: 0 }; }, impactAnalysis(file, depth) { return depth === 1 ? graph[file] || [] : ['native-flat-depth-' + depth]; } };`);
	const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../dist/index.js', import.meta.url)), `--db=${path.join(root, 'graph.db')}`, `--index-root=${root}`], env: { ...process.env, CODEGRAPH_NAPI_PATH: native }, stderr: 'pipe' });
	const client = new Client({ name: 'impact-test', version: '1' });
	t.after(async () => { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	await client.connect(transport);
	let ready = false;
	for (let index = 0; index < 50; index++) {
		const result = await client.callTool({ name: 'codegraph_status', arguments: {} });
		if (JSON.parse(result.content[0].text).structural) { ready = true; break; }
		await new Promise(resolve => setTimeout(resolve, 40));
	}
	assert.equal(ready, true);
	const text = 'export const unsaved = 2;';
	await client.notification({ method: 'notifications/son-of-anton/editor-overlay', params: { workspace: root, revision: 2, documents: [{ path: target, version: 4, language: 'typescript', text, outlineAvailable: true, symbols: [] }] } });
	await client.notification({ method: 'notifications/son-of-anton/editor-overlay', params: { workspace: root, revision: 1, documents: [] } });
	const impact = async args => {
		const result = await client.callTool({ name: 'impact_analysis', arguments: { path: target, ...args } });
		assert.notEqual(result.isError, true, result.content[0].text);
		return JSON.parse(result.content[0].text);
	};
	const detailed = await impact({ details: true, depth: 2 });
	assert.deepEqual([detailed.paths, detailed.fileBased, detailed.truncated], [[[a, target], [b, target], [c, a, target], [c, b, target]], true, false]);
	assert.deepEqual([detailed.unsavedDocuments.revision, detailed.unsavedDocuments.documents.map(document => [document.path, document.version]), await readFile(target, 'utf8')], [2, [[target, 4]], 'export const saved = 1;']);
	assert.match(detailed.unsavedDocuments.retrieval, /persisted dependencies exclude unsaved edits/);
	assert.deepEqual((await impact({ details: true, depth: 1 })).paths, [[a, target], [b, target]]);
	assert.deepEqual(await impact({ details: false, depth: 3 }), ['native-flat-depth-3']);
	assert.deepEqual(await impact({ depth: 4 }), ['native-flat-depth-4']);
	for (const depth of [0, 21]) { assert.equal((await client.callTool({ name: 'impact_analysis', arguments: { path: target, details: true, depth } })).isError, true); }
	await client.notification({ method: 'notifications/son-of-anton/editor-overlay', params: { workspace: root, revision: 3, documents: [] } });
	const saved = await impact({ details: true, depth: 2 });
	assert.deepEqual([saved.paths, saved.unsavedDocuments.documents], [detailed.paths, []]);
});
