/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, connect } from './installed-fixture.mjs';

async function providerFixture(t, respond) {
	const app = await fixture(t);
	const server = createServer(async (req, res) => {
		try {
			const chunks = []; for await (const chunk of req) { chunks.push(chunk); }
			const body = JSON.parse(Buffer.concat(chunks).toString());
			await respond(req, res, body);
		} catch { if (!res.headersSent) { res.writeHead(500); } res.end(); }
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	app.cleanups.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
	const live = await connect(app, [`--provider-embedder=http://127.0.0.1:${server.address().port}/embeddings?private=endpoint-only-secret|fixture-v1|3`], { CODEGRAPH_EMBEDDING_API_KEY: 'fixture-key' });
	// Measure provider rejection after structural initialization, excluding cold native startup.
	await live.until(async () => (await live.call('codegraph_status')).structural);
	return { app, live };
}

function vectors(input) {
	return { data: input.map((text, index) => ({ index, embedding: /settings/i.test(text) ? [1, 0, 0] : [0, 1, 0] })) };
}

for (const mode of ['declared', 'chunked']) {
	test(`native provider rejects ${mode} oversized bodies and retains structural tools`, { timeout: 30000 }, async t => {
		const { live } = await providerFixture(t, (_req, res, body) => {
			if (mode === 'declared') {
				res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(128 * 1024 * 1024) }); res.flushHeaders();
			} else {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.write(' '.repeat(64 * 1024)); res.end(JSON.stringify(vectors(body.input)));
			}
		});
		await live.until(async () => (await live.call('codegraph_status')).semantic === 'error', 3500);
		const status = await live.call('codegraph_status');
		assert.match(status.reason, /response exceeds size limit/); assert.doesNotMatch(status.reason, /fixture-key|endpoint-only-secret/);
		assert.equal(status.structural, true);
		assert.equal((await live.call('symbol_lookup', { query: 'loadProjectSettings' })).length, 1);
		assert.equal((await live.client.listTools()).tools.some(tool => tool.name === 'semantic_search'), false);
	});
}

test('native provider rejects redirects without forwarding code or credentials', { timeout: 30000 }, async t => {
	let redirected = 0;
	const { live } = await providerFixture(t, (req, res, body) => {
		if (req.url.startsWith('/embeddings')) { res.writeHead(307, { location: '/redirect-target' }); res.end(); }
		else { redirected++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(vectors(body.input))); }
	});
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'error', 3500);
	assert.equal(redirected, 0);
	const status = await live.call('codegraph_status'); assert.match(status.reason, /HTTP 307/); assert.doesNotMatch(status.reason, /fixture-key|endpoint-only-secret/);
});

test('native provider bounds concurrent requests and recovers after rejected credentials', { timeout: 30000 }, async t => {
	let active = 0, peak = 0, mode = 'ready', authenticated = true;
	const { app, live } = await providerFixture(t, async (req, res, body) => {
		authenticated &&= req.headers.authorization === 'Bearer fixture-key';
		if (mode === 'unauthorized') { res.writeHead(401); res.end('fixture-key must not appear in diagnostics'); return; }
		active++; peak = Math.max(peak, active);
		await new Promise(resolve => setTimeout(resolve, 100)); active--;
		res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(vectors(body.input)));
	});
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready');
	await Promise.all(Array.from({ length: 24 }, async () => {
		const hits = await live.call('semantic_search', { query: 'saved settings', limit: 1 }); assert.equal(hits[0].symbol, 'loadProjectSettings');
	}));
	assert.ok(peak <= 8, `Provider received ${peak} concurrent requests`); assert.ok(authenticated);
	mode = 'unauthorized';
	await writeFile(join(app.workspace, 'settings.ts'), 'export function changedSettings() { return "changed saved settings"; }\n');
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'error');
	const status = await live.call('codegraph_status'); assert.match(status.reason, /HTTP 401/); assert.doesNotMatch(status.reason, /fixture-key|endpoint-only-secret/);
	assert.equal((await live.call('symbol_lookup', { query: 'changedSettings' })).length, 1);
	mode = 'ready';
	await writeFile(join(app.workspace, 'settings.ts'), 'export function recoveredSettings() { return "restored saved settings"; }\n');
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready' && (await live.call('symbol_lookup', { query: 'recoveredSettings' })).length === 1);
	assert.equal((await live.call('semantic_search', { query: 'saved settings', limit: 1 }))[0].symbol, 'recoveredSettings');
	t.diagnostic(`24 concurrent searches bounded to ${peak} HTTP requests; credential outage recovered after file change`);
});


test('native provider transport errors omit endpoint query secrets', { timeout: 30000 }, async t => {
	const { live } = await providerFixture(t, (_req, res) => res.destroy());
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'error');
	const status = await live.call('codegraph_status');
	assert.match(status.reason, /embedding http/);
	assert.doesNotMatch(status.reason, /fixture-key|endpoint-only-secret/);
	assert.equal(status.structural, true);
});
