/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, connect } from './installed-fixture.mjs';

const source = fileURLToPath(new URL('../../../../son-of-anton-core/src/', import.meta.url));
async function sourceFiles(root) {
	const files = [];
	for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && !/test|fixture/i.test(entry.name)) { files.push(...await sourceFiles(path)); }
		else if (entry.isFile() && entry.name.endsWith('.ts') && !/\.(test|d)\.ts$/.test(entry.name)) { files.push(path); }
	}
	return files;
}

test('five-minute installed graph soak over application source keeps edits fresh and worker memory bounded', { skip: process.env.SOTA_TEST_GRAPH_SOAK !== '1', timeout: 420000 }, async t => {
	const app = await fixture(t), corpus = (await sourceFiles(source)).slice(0, 50);
	assert.equal(corpus.length, 50);
	for (const path of corpus) {
		const destination = join(app.workspace, 'application', relative(source, path)); await mkdir(dirname(destination), { recursive: true }); await copyFile(path, destination);
	}
	const provider = createServer(async (req, res) => {
		try {
			const chunks = []; for await (const chunk of req) { chunks.push(chunk); }
			const { input } = JSON.parse(Buffer.concat(chunks).toString());
			const data = input.map((text, index) => { const hash = createHash('sha256').update(text).digest(); return { index, embedding: Array.from({ length: 16 }, (_, i) => (hash[i] + 1) / 256) }; });
			res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data }));
		} catch { res.writeHead(500); res.end(); }
	});
	await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
	app.cleanups.push(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
	const live = await connect(app, [`--provider-embedder=http://127.0.0.1:${provider.address().port}/embeddings|soak-v1|16`]);
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready', 60000);
	const initial = await live.call('codegraph_status'); assert.equal(initial.stats.totalFiles, 52);
	const worker = process.platform === 'win32' ? undefined : execFileSync('pgrep', ['-P', String(live.pid)], { encoding: 'utf8' }).trim().split(/\s+/);
	if (worker) { assert.equal(worker.length, 1, 'Exactly one native worker should serve this MCP process'); }
	const memory = [];
	const sampleMemory = () => {
		if (!worker) { return; }
		const rssKiB = Number(execFileSync('ps', ['-o', 'rss=', '-p', worker[0]], { encoding: 'utf8' }).trim());
		assert.ok(Number.isFinite(rssKiB) && rssKiB > 0); memory.push(rssKiB * 1024);
	};
	let cycles = 0, searches = 0, maxStatusMs = 0, baselineRss;
	const started = performance.now();
	while (performance.now() - started < 300000) {
		const before = performance.now(); const status = await live.call('codegraph_status'); maxStatusMs = Math.max(maxStatusMs, performance.now() - before);
		assert.equal(status.semantic, 'ready', status.reason);
		await Promise.all(Array.from({ length: 20 }, async (_, query) => {
			const hits = await live.call('semantic_search', { query: `source maintenance ${cycles} ${query}`, limit: 5 });
			assert.equal(hits.length, 5); assert.ok(hits.every(hit => Number.isFinite(hit.score))); searches++;
		}));
		cycles++;
		const current = `soakCycle${cycles}`, previous = `soakCycle${cycles - 1}`;
		await writeFile(join(app.workspace, 'churn.ts'), `export function ${current}(amount: number) { return amount + ${cycles}; }\n`);
		await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready' && (await live.call('symbol_lookup', { query: current })).some(hit => hit.name === current));
		assert.deepEqual(await live.call('symbol_lookup', { query: previous }), []);
		if (cycles % 5 === 0) {
			sampleMemory(); if (cycles === 10) { baselineRss = memory.at(-1); }
			if (baselineRss !== undefined) { assert.ok(memory.at(-1) - baselineRss < 128 * 1024 * 1024, 'Worker RSS grew by more than 128 MiB after warmup'); }
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	assert.ok(cycles >= 10); assert.ok(maxStatusMs < 1000, `Status stalled for ${maxStatusMs} ms`);
	sampleMemory();
	const result = { durationMs: performance.now() - started, copiedSourceFiles: corpus.map(path => relative(source, path)), indexedSymbols: initial.stats.totalSymbols, cycles, searches, maxStatusMs, workerRss: memory.length ? { baselineBytes: baselineRss, peakBytes: Math.max(...memory), finalBytes: memory.at(-1) } : null, embedding: 'generated vectors: capacity and lifecycle only, not relevance quality' };
	t.diagnostic(JSON.stringify(result));
	if (process.env.SOTA_GRAPH_SOAK_OUTPUT) { await writeFile(process.env.SOTA_GRAPH_SOAK_OUTPUT, JSON.stringify(result, null, 2) + '\n'); }
});
