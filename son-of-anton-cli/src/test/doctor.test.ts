/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCliHost } from '../cliHost';
import { collectDiagnostics } from '../commands/doctor';

test('doctor reports compatible runtime and credential presence without leaking values', async t => {
	const runtime = await mkdtemp(path.join(os.tmpdir(), 'sota-doctor-'));
	t.after(() => rm(runtime, { recursive: true, force: true }));
	await mkdir(path.join(runtime, 'node_modules/@son-of-anton/codegraph-napi'), { recursive: true });
	await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, nodeMajor: 22 }));
	await writeFile(path.join(runtime, 'index.cjs'), '');
	await writeFile(path.join(runtime, 'node_modules/@son-of-anton/codegraph-napi/engine.node'), '');
	const host = buildCliHost();
	const diagnostics = await collectDiagnostics({ ...host, secrets: { get: async () => 'synthetic-secret-do-not-print', store: async () => {}, delete: async () => {} } }, runtime);
	assert.equal(diagnostics.find(item => item.name === 'Code graph')?.status, 'ok');
	assert.equal(JSON.stringify(diagnostics).includes('synthetic-secret-do-not-print'), false);
	await writeFile(path.join(runtime, 'manifest.json'), JSON.stringify({ platform: 'other', arch: 'other', nodeMajor: 22 }));
	const broken = await collectDiagnostics({ ...host, secrets: { get: async () => { throw new Error('locked'); }, store: async () => {}, delete: async () => {} } }, runtime);
	assert.deepEqual(broken.filter(item => ['Credentials', 'Code graph'].includes(item.name)).map(item => item.status), ['repair', 'repair']);
});
