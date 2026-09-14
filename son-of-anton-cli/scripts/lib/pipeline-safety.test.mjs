/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyArchive } from './node-archive.mjs';

test('archive verification rejects missing checksums and corrupted bytes', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-archive-check-')); t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, 'archive');
	const checksum = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
	await writeFile(file, 'abc'); verifyArchive(file, checksum);
	assert.throws(() => verifyArchive(file, undefined), /pinned SHA-256/);
	await writeFile(file, 'abd'); assert.throws(() => verifyArchive(file, checksum), /does not match/);
});

test('a real pipeline vendor failure preserves the prior CLI and removes partial output', { timeout: 120000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-pipeline-failure-')); t.after(() => rm(root, { recursive: true, force: true }));
	const output = join(root, 'dist-bundle'), bin = join(root, 'bin');
	await mkdir(output); await mkdir(bin);
	await writeFile(join(output, 'sota'), 'last successful CLI');
	await writeFile(join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), process.platform === 'win32' ? '@echo off\r\nexit /b 17\r\n' : '#!/bin/sh\nexit 17\n', { mode: 0o755 });
	const module = new URL('./sea-pipeline.mjs', import.meta.url).href;
	const script = `import { runPipeline } from ${JSON.stringify(module)}; await runPipeline({ os: process.platform, cpu: process.arch, blobName: 'sota.blob', binaryName: 'sota' }, { outputDir: ${JSON.stringify(output)} });`;
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 110000, env: { ...process.env, PATH: bin + delimiter + (process.env.PATH || '') } });
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /vendor npm install failed: 17/);
	assert.equal(await readFile(join(output, 'sota'), 'utf8'), 'last successful CLI');
	assert.deepEqual(await readdir(output), ['sota']);
	assert.deepEqual((await readdir(root)).sort(), ['bin', 'dist-bundle']);
});
