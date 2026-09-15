/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';

test('gateway survives a graph outage, fails requests promptly, and reconnects', {
	skip: process.env.SOTA_TEST_DOCKER !== '1', timeout: 60000,
}, async t => {
	const require = createRequire(import.meta.url);
	const { FalkorDBClient } = require('../../services/mcp-gateway/dist/clients/falkordb.js');
	const name = `sota-graph-recovery-${randomUUID()}`;
	const docker = args => {
		const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15000 });
		assert.equal(result.status, 0, `Docker ${args[0]} failed: ${result.stderr}`);
		return result.stdout.trim();
	};
	let client = undefined;
	let paused = false;
	t.after(async () => { try { await client?.disconnect(); } finally { if (paused) { docker(['unpause', name]); } docker(['rm', '-fv', name]); } });
	const reservation = createServer();
	await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
	const port = reservation.address().port;
	await new Promise(resolve => reservation.close(resolve));
	// An unspecified Docker host port is reallocated on restart. Keep this
	// fixture's port stable so it tests recovery at the same service address.
	docker(['run', '-d', '--name', name, '--memory', '256m', '--cpus', '1', '-p', `127.0.0.1:${port}:6379`, 'falkordb/falkordb:latest']);
	let ready = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		const ping = spawnSync('docker', ['exec', name, 'redis-cli', 'PING'], { encoding: 'utf8', timeout: 5000 });
		if (ping.status === 0 && ping.stdout.trim() === 'PONG') { ready = true; break; }
		await setTimeout(250);
	}
	assert.ok(ready, 'Disposable graph must start');
	client = new FalkorDBClient('127.0.0.1', port, 'recovery-fixture');
	await client.connect();
	assert.deepEqual((await client.query('RETURN 42 AS answer')).rows, [[{ answer: 42 }]]);
	docker(['stop', '-t', '1', name]);
	await setTimeout(100);
	const promptly = async work => {
		let timer;
		try { return await Promise.race([work, new Promise((_, reject) => { timer = globalThis.setTimeout(() => reject(new Error('Disconnected requests must finish within two seconds')), 2000); })]); }
		finally { clearTimeout(timer); }
	};
	assert.equal(await promptly(client.isHealthy()), false);
	await assert.rejects(promptly(client.query('RETURN 42 AS answer')), /not connected|not ready|offline|closed/i);
	docker(['start', name]);
	let recovered = false;
	for (let attempt = 0; attempt < 80; attempt++) {
		if (await promptly(client.isHealthy())) { recovered = true; break; }
		await setTimeout(250);
	}
	assert.ok(recovered, 'Graph client must recover without restarting the gateway');
	assert.deepEqual((await client.query('RETURN 42 AS answer')).rows, [[{ answer: 42 }]]);
	docker(['pause', name]); paused = true;
	const started = Date.now();
	const results = await Promise.allSettled([client.isHealthy(), client.query('RETURN 42 AS answer')]);
	assert.equal(results[0].status, 'fulfilled');
	assert.equal(results[0].value, false);
	assert.equal(results[1].status, 'rejected');
	assert.ok(Date.now() - started < 3000, 'A connected but silent graph must not hang requests');
	docker(['unpause', name]); paused = false;
	recovered = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		if (await client.isHealthy()) { recovered = true; break; }
		await setTimeout(250);
	}
	assert.ok(recovered, 'Graph must recover after a stalled connection is discarded');
	const answers = await Promise.all(Array.from({ length: 50 }, (_, value) => client.query('RETURN $value AS answer', { value })));
	assert.deepEqual(answers.map(result => result.rows[0][0].answer), Array.from({ length: 50 }, (_, value) => value));
});
