/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, connect } from './installed-fixture.mjs';

test('slow native loading and vector construction do not stall MCP status requests', { timeout: 15000 }, async t => {
	const app = await fixture(t);
	const module = join(app.directory, 'slow-native.cjs');
	await writeFile(module, `
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
pause(1800);
module.exports = {
 init() {},
 async indexWorkspace() { return { files: 2, symbols: 2, edges: 0, skippedUnchanged: 0 }; },
 async configureLocalEmbedder() {},
 async embedAll() {},
 buildVectorIndex() { pause(1800); return 2; },
 symbolLookup() { return [{ name: 'loadProjectSettings' }]; }
};
`);
	const live = await connect(app, ['--local-embedder'], { CODEGRAPH_NAPI_PATH: module });
	const samples = [];
	await live.until(async () => {
		const before = performance.now();
		const status = await live.call('codegraph_status');
		const latency = performance.now() - before;
		samples.push({ state: status.state, semantic: status.semantic, latency });
		assert.ok(latency < 750, `MCP status blocked for ${latency.toFixed(0)} ms`);
		return status.semantic === 'ready';
	});
	assert.ok(samples.some(sample => sample.state === 'starting'));
	assert.ok(samples.some(sample => sample.semantic === 'building'));
	assert.equal((await live.call('symbol_lookup', { query: 'loadProjectSettings' }))[0]?.name, 'loadProjectSettings');
});

test('worker exit rejects pending calls and removes unavailable graph capabilities', { timeout: 15000 }, async t => {
	const app = await fixture(t);
	const module = join(app.directory, 'crashing-native.cjs');
	await writeFile(module, `module.exports = {
 init() {},
 async indexWorkspace() { return { files: 2, symbols: 2, edges: 0, skippedUnchanged: 0 }; },
 async configureLocalEmbedder() {}, async embedAll() {}, buildVectorIndex() { return 2; },
 semanticSearch() { process.exit(9); }
};`);
	const live = await connect(app, ['--local-embedder'], { CODEGRAPH_NAPI_PATH: module });
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready');
	await assert.rejects(live.call('semantic_search', { query: 'trigger native failure' }), /worker (exited|disconnected)/);
	const status = await live.call('codegraph_status');
	assert.deepEqual([status.state, status.structural], ['failed', false]);
	assert.deepEqual((await live.client.listTools()).tools.map(tool => tool.name), ['codegraph_status']);
});

test('closing the client interrupts a blocked native worker', { timeout: 15000 }, async t => {
	const app = await fixture(t);
	const module = join(app.directory, 'blocked-native.cjs');
	await writeFile(module, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); module.exports = {};');
	const live = await connect(app, [], { CODEGRAPH_NAPI_PATH: module });
	assert.equal((await live.call('codegraph_status')).state, 'starting');
	const before = performance.now();
	await live.client.close();
	assert.ok(performance.now() - before < 1500, 'Closing should not wait for native initialization');
});

test('a saturated worker rejects excess queries while status and shutdown remain available', { timeout: 15000 }, async t => {
	const app = await fixture(t);
	const module = join(app.directory, 'saturated-native.cjs');
	await writeFile(module, `module.exports = {
 init() {}, async indexWorkspace() { return { files: 2, symbols: 2, edges: 0, skippedUnchanged: 0 }; },
 async configureLocalEmbedder() {}, async embedAll() {}, buildVectorIndex() { return 2; },
 semanticSearch() { return new Promise(() => {}); }
};`);
	const live = await connect(app, ['--local-embedder'], { CODEGRAPH_NAPI_PATH: module });
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready');
	const requests = Array.from({ length: 300 }, () => live.call('semantic_search', { query: 'busy' }).catch(error => error));
	assert.match((await Promise.race(requests)).message, /Code graph is busy/);
	assert.equal((await live.call('codegraph_status')).state, 'ready');
	await live.client.close();
	await Promise.all(requests);
});
