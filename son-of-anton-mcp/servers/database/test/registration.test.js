/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

test('authenticated database MCP exposes valid schemas and rejects invalid arguments before querying', { timeout: 15000 }, async t => {
	const reservation = createServer().listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	const token = 'database-registration-fixture';
	const child = spawn(process.execPath, [path.join(__dirname, '../dist/index.js')], {
		env: { ...process.env, MCP_DATABASE_PORT: String(port), SOTA_SERVICE_TOKEN: token, DB_HOST: '127.0.0.1', DB_PORT: '1' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const closed = once(child, 'close');
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); } await closed; });
	await new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', code => reject(new Error(`Database server exited ${code} before listening`)));
		child.stdout.on('data', data => { if (data.toString().includes('Listening on port')) { resolve(); } });
	});
	const url = `http://127.0.0.1:${port}`;
	assert.equal((await fetch(url + '/sse')).status, 401);
	const client = new Client({ name: 'registration-test', version: '1' });
	t.after(() => client.close());
	await client.connect(new SSEClientTransport(new URL(url + '/sse'), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
	const tools = (await client.listTools()).tools;
	assert.deepEqual(tools.map(tool => tool.name).sort(), ['explain_query', 'query_schema', 'run_read_query', 'sample_data']);
	assert.equal(tools.find(tool => tool.name === 'sample_data').inputSchema.properties.limit.maximum, 100);
	const invalid = await client.callTool({ name: 'sample_data', arguments: { table: 'fixture', limit: 101 } });
	assert.equal(invalid.isError, true);
	assert.match(JSON.stringify(invalid.content), /100|validation|invalid/i);
	assert.doesNotMatch(JSON.stringify(invalid.content), /ECONNREFUSED/);
});
