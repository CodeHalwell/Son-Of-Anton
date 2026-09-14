/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const path = require('node:path');
const http = require('node:http');
const { QdrantClient } = require('../dist/clients/qdrant.js');

test('gateway exposes degraded health and enforces auth while datastores are unavailable', { timeout: 15000 }, async t => {
	const ports = await Promise.all([0, 1].map(async () => {
		const server = createServer();
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		return { server, port: server.address().port };
	}));
	await Promise.all(ports.map(({ server }) => new Promise(resolve => server.close(resolve))));
	const base = `http://127.0.0.1:${ports[0].port}`;
	const child = spawn(process.execPath, [path.resolve(__dirname, '../dist/index.js')], {
		env: { ...process.env, MCP_PORT: String(ports[0].port), SOTA_SERVICE_TOKEN: 'startup-fixture-token', FALKORDB_HOST: '127.0.0.1', FALKORDB_PORT: String(ports[1].port), QDRANT_HOST: '127.0.0.1', QDRANT_REST_PORT: String(ports[1].port), OTEL_EXPORTER_OTLP_ENDPOINT: '' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let logs = '';
	for (const stream of [child.stdout, child.stderr]) { stream.on('data', data => { logs = (logs + data).slice(-4000); }); }
	t.after(async () => {
		if (child.exitCode !== null || child.signalCode !== null) { return; }
		await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); });
	});
	let response;
	for (let attempt = 0; attempt < 50; attempt++) {
		try { response = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) }); break; }
		catch { assert.equal(child.exitCode, null, logs); await delay(100); }
	}
	assert.ok(response, `Health must be available before datastores connect: ${logs}`);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { status: 'degraded', service: 'mcp-gateway', backends: { falkordb: 'disconnected', qdrant: 'disconnected' } });
	assert.equal((await fetch(base + '/sse', { signal: AbortSignal.timeout(1000) })).status, 401);
});

test('vector health and search time out when a connected backend stops responding', { timeout: 10000 }, async t => {
	const server = http.createServer(() => {});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	const client = new QdrantClient('127.0.0.1', server.address().port, 'timeout-fixture');
	const started = Date.now();
	const results = await Promise.allSettled([client.isHealthy(), client.search([0, 1])]);
	assert.equal(results[0].status, 'fulfilled');
	assert.equal(results[0].value, false);
	assert.equal(results[1].status, 'rejected');
	assert.ok(Date.now() - started < 3500, 'Vector requests must finish within the health probe budget');
});
