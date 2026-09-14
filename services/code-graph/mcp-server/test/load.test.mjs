/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, connect } from './installed-fixture.mjs';

// Generated vectors isolate native indexing/search capacity from model-provider speed and quality.
test('2002-symbol native index stays responsive through concurrent search and file replacement', { skip: process.env.SOTA_TEST_GRAPH_LOAD !== '1', timeout: 120000 }, async t => {
	const app = await fixture(t);
	for (let file = 0; file < 100; file++) {
		await writeFile(join(app.workspace, `module${file}.ts`), Array.from({ length: 20 }, (_, index) => `export function compute${file}_${index}(amount: number) { return amount * ${file + 1} + ${index}; }`).join('\n'));
	}
	const provider = createServer(async (req, res) => {
		try {
			const chunks = []; for await (const chunk of req) { chunks.push(chunk); }
			const { input } = JSON.parse(Buffer.concat(chunks).toString());
			const data = input.map((text, index) => {
				const hash = createHash('sha256').update(text).digest();
				let seed = hash.readUInt32LE();
				return { index, embedding: Array.from({ length: 384 }, () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0xffffffff - 0.5; }) };
			});
			res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data }));
		} catch { res.writeHead(500); res.end(); }
	});
	await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
	app.cleanups.push(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
	const started = performance.now();
	const live = await connect(app, [`--provider-embedder=http://127.0.0.1:${provider.address().port}/embeddings|load-v1|384`]);
	const statusLatencies = [];
	const ready = async () => {
		const before = performance.now(); const status = await live.call('codegraph_status'); statusLatencies.push(performance.now() - before);
		assert.notEqual(status.state, 'failed', status.reason); assert.notEqual(status.semantic, 'error', status.reason);
		return status.semantic === 'ready';
	};
	await live.until(ready, 60000);
	const initialReadyMs = performance.now() - started;
	assert.equal((await live.call('codegraph_status')).stats.totalSymbols, 2002);
	const searchStart = performance.now();
	await Promise.all(Array.from({ length: 100 }, async (_, index) => {
		const hits = await live.call('semantic_search', { query: `calculate amount ${index}`, limit: 5 });
		assert.equal(hits.length, 5);
		assert.ok(hits.every(hit => Number.isFinite(hit.score) && hit.file.startsWith('/')) || hits.every(hit => Number.isFinite(hit.score) && /^[A-Za-z]:/.test(hit.file)));
	}));
	const concurrent100Ms = performance.now() - searchStart;
	for (let file = 0; file < 10; file++) { await writeFile(join(app.workspace, `module${file}.ts`), `export function replacement${file}(amount: number) { return amount * 2; }`); }
	await live.until(async () => await ready() && (await live.call('symbol_lookup', { query: 'replacement', limit: 20 })).length === 10, 60000);
	for (let file = 0; file < 10; file++) { assert.deepEqual(await live.call('symbol_lookup', { query: `compute${file}_`, limit: 100 }), []); }
	assert.ok(Math.max(...statusLatencies) < 1000, `Status stalled ${Math.max(...statusLatencies)} ms`);
	const result = { symbols: 2002, dimensions: 384, initialReadyMs, concurrent100Ms, maxStatusLatencyMs: Math.max(...statusLatencies), replacedFiles: 10 };
	t.diagnostic(JSON.stringify(result));
	if (process.env.SOTA_GRAPH_LOAD_OUTPUT) { await writeFile(process.env.SOTA_GRAPH_LOAD_OUTPUT, JSON.stringify(result, null, 2) + '\n'); }
});
