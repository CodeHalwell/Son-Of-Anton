/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createServer } from 'node:http';

import { fixture, connect } from './installed-fixture.mjs';

test('installed native graph indexes, embeds, searches, watches edits and isolates workspaces offline', { timeout: 45000 }, async t => {
	const app = await fixture(t);
	let embeddingRequests = 0;
	const provider = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) { chunks.push(chunk); }
		const body = JSON.parse(Buffer.concat(chunks).toString());
		embeddingRequests++;
		const data = body.input.map((input, index) => ({ index, embedding: /settings/i.test(input) ? [1, 0, 0] : /retry/i.test(input) ? [0, 1, 0] : [0, 0, 1] }));
		res.writeHead(200, { 'content-type': 'application/json' });
		// Reversed response order checks provider index handling as well.
		res.end(JSON.stringify({ data: data.reverse() }));
	});
	await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
	app.cleanups.push(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
	const live = await connect(app, [`--provider-embedder=http://127.0.0.1:${provider.address().port}/embeddings|fixture-v1|3`]);
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready');
	assert.equal((await live.call('codegraph_status')).stats.totalFiles, 2);
	const queries = [['load saved project settings', 'loadProjectSettings'], ['retry failed network requests', 'scheduleRetry']];
	const samples = [];
	for (const [query, expected] of queries) {
		const start = performance.now();
		const hits = await live.call('semantic_search', { query, limit: 1 });
		assert.equal(hits[0]?.symbol, expected);
		samples.push({ query, expected, retrieved: hits[0].symbol, latencyMs: performance.now() - start });
	}
	assert.ok(embeddingRequests >= 3);
	await fs.writeFile(path.join(app.workspace, 'settings.ts'), 'export function readCurrentSettings() { return "updated settings body"; }\n');
	await live.until(async () => (await live.call('codegraph_status')).structural && (await live.call('symbol_lookup', { query: 'readCurrentSettings' })).length === 1);
	assert.deepEqual(await live.call('symbol_lookup', { query: 'loadProjectSettings' }), []);
	await fs.rename(path.join(app.workspace, 'settings.ts'), path.join(app.workspace, 'moved.ts'));
	await live.until(async () => (await live.call('codegraph_status')).structural && (await live.call('symbol_lookup', { query: 'readCurrentSettings' }))[0]?.file.endsWith('moved.ts'));
	await fs.unlink(path.join(app.workspace, 'moved.ts'));
	await live.until(async () => (await live.call('codegraph_status')).structural && (await live.call('symbol_lookup', { query: 'readCurrentSettings' })).length === 0);
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready');
	await assert.rejects(live.call('semantic_search', { query: 'retry', limit: -1 }), /positive integer/);
	await live.client.close();
	const restarted = await connect(app);
	await restarted.until(async () => (await restarted.call('codegraph_status')).state === 'ready');
	assert.equal((await restarted.call('symbol_lookup', { query: 'scheduleRetry' })).length, 1);
	assert.deepEqual(await restarted.call('symbol_lookup', { query: 'readCurrentSettings' }), []);
	assert.equal((await restarted.call('codegraph_status')).stats.totalFiles, 1);
	await restarted.client.close();
	const otherWorkspace = path.join(app.directory, 'other');
	await fs.mkdir(otherWorkspace);
	const other = await connect({ ...app, workspace: otherWorkspace });
	await other.until(async () => (await other.call('codegraph_status')).state === 'failed');
	await assert.rejects(other.call('symbol_lookup', { query: 'scheduleRetry' }), /another workspace/);
	if (process.env.SOTA_EVAL_OUTPUT) {
		await fs.writeFile(process.env.SOTA_EVAL_OUTPUT, JSON.stringify({ fixture: 'retrieval-v1', embedding: 'deterministic-offline', recallAt1: 1, staleResults: 0, crossWorkspaceResults: 0, providerCalls: embeddingRequests, samples }, null, 2) + '\n');
	}
});

test('structural-only and missing-native installs advertise accurate capabilities', { timeout: 30000 }, async t => {
	const app = await fixture(t);
	const structural = await connect(app);
	await structural.until(async () => (await structural.call('codegraph_status')).state === 'ready');
	assert.equal((await structural.client.listTools()).tools.some(tool => tool.name === 'semantic_search'), false);
	await assert.rejects(structural.call('semantic_search', { query: 'settings' }), /disabled/);
	await structural.client.close();
	await fs.unlink(path.join(app.runtime, 'node_modules/@son-of-anton/codegraph-napi/engine.node'));
	const broken = await connect(app);
	await broken.until(async () => (await broken.call('codegraph_status')).state === 'failed');
	assert.deepEqual((await broken.client.listTools()).tools.map(tool => tool.name), ['codegraph_status']);
	await assert.rejects(broken.call('symbol_lookup', { query: 'settings' }), /could not start/);
});

test('installed native impact analysis retains both indexed routes through a shared dependent', { timeout: 30000 }, async t => {
	const app = await fixture(t);
	const sources = {
		'impact-target.ts': 'export function changedOperation() { return 1; }\n',
		'impact-a.ts': 'import { changedOperation } from "./impact-target"; export function dependentA() { return changedOperation(); }\n',
		'impact-b.ts': 'import { changedOperation } from "./impact-target"; export function dependentB() { return changedOperation(); }\n',
		'impact-shared.test.ts': 'import { dependentA } from "./impact-a"; import { dependentB } from "./impact-b"; export function checkBoth() { return dependentA() + dependentB(); }\n',
	};
	for (const [name, source] of Object.entries(sources)) { await fs.writeFile(path.join(app.workspace, name), source); }
	const live = await connect(app);
	await live.until(async () => (await live.call('codegraph_status')).state === 'ready');
	const target = path.join(app.workspace, 'impact-target.ts');
	const detailed = await live.call('impact_analysis', { path: target, details: true, depth: 2 });
	assert.deepEqual(detailed.paths.map(chain => chain.map(filename => path.basename(filename))), [
		['impact-a.ts', 'impact-target.ts'], ['impact-b.ts', 'impact-target.ts'],
		['impact-shared.test.ts', 'impact-a.ts', 'impact-target.ts'], ['impact-shared.test.ts', 'impact-b.ts', 'impact-target.ts'],
	]);
	assert.deepEqual([detailed.fileBased, detailed.truncated, detailed.unsavedDocuments.documents], [true, false, []]);
	const flat = await live.call('impact_analysis', { path: target, details: false, depth: 2 });
	assert.deepEqual(flat.map(filename => path.basename(filename)).sort(), ['impact-a.ts', 'impact-b.ts', 'impact-shared.test.ts']);
});

test('unavailable local model download keeps structural tools usable and reports semantic failure', { timeout: 30000 }, async t => {
	const app = await fixture(t);
	const live = await connect(app, ['--local-embedder'], { HF_ENDPOINT: 'http://127.0.0.1:1' });
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'error');
	const status = await live.call('codegraph_status');
	assert.deepEqual([status.state, status.structural, status.semantic], ['degraded', true, 'error']);
	assert.match(status.reason, /Embedding failed/);
	assert.equal((await live.call('symbol_lookup', { query: 'loadProjectSettings' }))[0]?.name, 'loadProjectSettings');
	assert.equal((await live.client.listTools()).tools.some(tool => tool.name === 'semantic_search'), false);
	await assert.rejects(live.call('semantic_search', { query: 'saved settings' }), /Semantic search is error/);
});

test('closing a real native graph cancels a stalled local model download promptly', { timeout: 15000 }, async t => {
	const app = await fixture(t);
	let requested = false;
	const host = createServer((_req, _res) => { requested = true; });
	await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
	app.cleanups.push(() => new Promise(resolve => { host.close(resolve); host.closeAllConnections(); }));
	const live = await connect(app, ['--local-embedder'], { HF_ENDPOINT: `http://127.0.0.1:${host.address().port}` });
	await live.until(() => requested);
	assert.equal((await live.call('codegraph_status')).semantic, 'building');
	const before = performance.now();
	await live.client.close();
	const closeMs = performance.now() - before;
	t.diagnostic(`Stalled native download closed in ${closeMs.toFixed(0)} ms`);
	assert.ok(closeMs < 2000, 'Native download shutdown should finish before transport escalation');
});
