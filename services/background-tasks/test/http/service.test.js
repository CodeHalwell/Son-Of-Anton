/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('background service authenticates task reads and rejects disallowed images without Docker execution', { timeout: 15000 }, async t => {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-background-http-'));
	const probe = createServer();
	await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
	const port = probe.address().port;
	await new Promise(resolve => probe.close(resolve));
	const child = spawn(process.execPath, [path.join(__dirname, '../../dist/index.js')], { env: { ...process.env, STATE_DIR: root, BACKGROUND_TASKS_PORT: String(port), BACKGROUND_TASK_API_TOKEN: 'fixture-service-token', BACKGROUND_TASK_WORKSPACE_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
	t.after(async () => { child.kill('SIGTERM'); await new Promise(resolve => { if (child.exitCode !== null || child.signalCode) { resolve(); } else { child.once('exit', resolve); } }); await rm(root, { recursive: true, force: true }); });
	const base = `http://127.0.0.1:${port}`;
	for (let attempt = 0; attempt < 100; attempt++) {
		if (output.includes('Listening on port')) { break; }
		if (child.exitCode !== null) { assert.fail(output); }
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	assert.match(output, /Listening on port/);
	assert.equal((await fetch(base + '/health')).status, 200);
	assert.equal((await fetch(base + '/tasks')).status, 401);
	const headers = { Authorization: 'Bearer fixture-service-token', 'Content-Type': 'application/json' };
	const tasks = await fetch(base + '/tasks', { headers });
	assert.equal(tasks.status, 200); assert.deepEqual(await tasks.json(), []);
	const rejected = await fetch(base + '/tasks', { method: 'POST', headers, body: JSON.stringify({ name: 'fixture', description: 'fixture', image: 'disallowed-fixture:latest', projectPath: root }) });
	assert.equal(rejected.status, 400);
	assert.deepEqual(await (await fetch(base + '/tasks', { headers })).json(), []);
});
