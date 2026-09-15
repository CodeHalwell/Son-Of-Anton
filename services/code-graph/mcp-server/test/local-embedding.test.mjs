/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fixture, connect } from './installed-fixture.mjs';

// Opt in explicitly: this test downloads the actual BGE model into its disposable fixture.
test('real local embeddings stay responsive, retrieve paraphrased queries and survive edits and restarts', { skip: process.env.SOTA_TEST_LOCAL_EMBEDDINGS !== '1', timeout: 180000 }, async t => {
	const app = await fixture(t);
	const sources = {
		'cart.ts': 'export function cartTotal(items) { return items.reduce((sum, item) => sum + item.price * item.quantity, 0); }',
		'password.ts': 'export function passwordDigest(password, salt) { return crypto.scryptSync(password, salt, 64).toString("hex"); }',
		'calendar.ts': 'export function nextAppointment(events, now) { return events.filter(event => event.start > now).sort((a, b) => a.start - b.start)[0]; }',
		'images.ts': 'export function createThumbnail(image) { return image.resize({ width: 160, height: 160, fit: "cover" }).jpeg().toBuffer(); }',
		'cache.ts': 'export function evictExpiredEntries(cache, now) { for (const [key, entry] of cache) { if (entry.expiresAt <= now) cache.delete(key); } }',
		'csv.ts': 'export function exportCsv(rows) { return rows.map(row => row.map(value => `"${String(value).replaceAll("\\\"", "\\\"\\\"")}"`).join(",")).join("\\n"); }'
	};
	for (const [name, source] of Object.entries(sources)) { await fs.writeFile(path.join(app.workspace, name), source + '\n'); }
	const started = performance.now();
	const live = await connect(app, ['--local-embedder']);
	const samples = [], statusLatencies = [], statusSamples = [];
	let observedLoading = false;
	await live.until(async () => {
		const before = performance.now();
		const status = await live.call('codegraph_status');
		statusLatencies.push(performance.now() - before);
		statusSamples.push({ elapsedMs: performance.now() - started, latencyMs: statusLatencies.at(-1), state: status.state, structural: status.structural, semantic: status.semantic });
		assert.notEqual(status.semantic, 'error', status.reason);
		if (status.structural && status.semantic === 'building') {
			observedLoading = true;
			assert.equal((await live.call('symbol_lookup', { query: 'cartTotal' }))[0]?.name, 'cartTotal');
		}
		return status.semantic === 'ready';
	}, 120000);
	const coldReadyMs = performance.now() - started;
	t.diagnostic(JSON.stringify({ statusSamples }));
	assert.ok(observedLoading, 'Observed structural queries during real model initialization');
	assert.ok(Math.max(...statusLatencies) < 1000, `Status request stalled: ${Math.max(...statusLatencies)}ms`);
	assert.ok((await fs.readdir(path.join(app.directory, 'graph.db.models'))).length > 0);
	assert.deepEqual((await fs.readdir(app.workspace)).sort(), [...Object.keys(sources), 'retry.ts', 'settings.ts'].sort());
	const queries = [
		['calculate the shopping basket bill', 'cartTotal'],
		['securely hash a secret for authentication', 'passwordDigest'],
		['find the soonest upcoming meeting', 'nextAppointment'],
		['make a small preview picture', 'createThumbnail'],
		['remove cached values whose lifetime has elapsed', 'evictExpiredEntries'],
		['save tabular records as comma separated text', 'exportCsv']
	];
	for (const [query, expected] of queries) {
		const before = performance.now();
		const hits = await live.call('semantic_search', { query, limit: 3 });
		samples.push({ query, expected, retrieved: hits.map(hit => hit.symbol), latencyMs: performance.now() - before });
		assert.equal(hits[0]?.symbol, expected, query);
	}
	const concurrentStart = performance.now();
	await Promise.all(Array.from({ length: 32 }, async (_, index) => {
		const [query, expected] = queries[index % queries.length];
		assert.equal((await live.call('semantic_search', { query, limit: 1 }))[0]?.symbol, expected);
	}));
	const concurrent32Ms = performance.now() - concurrentStart;
	await fs.writeFile(path.join(app.workspace, 'cart.ts'), sources['cart.ts'].replace('cartTotal', 'basketInvoice').replace('item.quantity', 'item.quantity * 1.2'));
	await live.until(async () => (await live.call('symbol_lookup', { query: 'basketInvoice' })).length === 1 && (await live.call('codegraph_status')).semantic === 'ready');
	assert.deepEqual(await live.call('symbol_lookup', { query: 'cartTotal' }), []);
	const updated = await live.call('semantic_search', { query: queries[0][0], limit: 1 });
	assert.equal(updated[0]?.symbol, 'basketInvoice');
	assert.match(updated[0].snippet, /quantity \* 1\.2/);
	await live.client.close();
	const warmStart = performance.now();
	// A cached model must restart without contacting a reachable model host.
	const restarted = await connect(app, ['--local-embedder'], { HF_ENDPOINT: 'http://127.0.0.1:1' });
	await restarted.until(async () => (await restarted.call('codegraph_status')).semantic === 'ready');
	const warmReadyMs = performance.now() - warmStart;
	assert.equal((await restarted.call('semantic_search', { query: queries[0][0], limit: 1 }))[0]?.symbol, 'basketInvoice');
	assert.equal((await restarted.call('codegraph_status')).stats.skippedUnchanged, 8);
	const result = { model: 'BGE-small-en-v1.5', fixture: 'local-paraphrase-v1', coldReadyMs, warmReadyMs, concurrent32Ms, maxStatusLatencyMs: Math.max(...statusLatencies), recallAt1: 1, samples };
	t.diagnostic(JSON.stringify(result));
	if (process.env.SOTA_LOCAL_EVAL_OUTPUT) { await fs.writeFile(process.env.SOTA_LOCAL_EVAL_OUTPUT, JSON.stringify(result, null, 2) + '\n'); }
});
