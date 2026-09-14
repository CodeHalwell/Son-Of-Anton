/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { packageAll } from '../package-all.mjs';

const binaries = { 'package-macos-arm64.mjs': 'sota', 'package-linux-x64.mjs': 'sota-linux-x64', 'package-windows-x64.mjs': 'sota-windows-x64.exe' };
async function candidate(script, directory) {
	await mkdir(directory); await writeFile(join(directory, binaries[script]), script);
	await writeFile(join(directory, 'THIRD_PARTY_LICENSES.txt'), `licenses ${script}`);
}

for (const failure of ['second target fails', 'required license missing']) {
	test(`package all preserves the previous set when ${failure}`, async t => {
		const root = await mkdtemp(join(tmpdir(), 'sota-package-all-')); t.after(() => rm(root, { recursive: true, force: true }));
		const output = join(root, 'release'); await mkdir(output); await writeFile(join(output, 'sota'), 'last successful release');
		await assert.rejects(packageAll({ outputDir: output, runTarget: async (script, directory) => {
			if (failure === 'second target fails' && script === 'package-linux-x64.mjs') { throw new Error('target failed'); }
			await candidate(script, directory);
			if (failure === 'required license missing') { await rm(join(directory, 'THIRD_PARTY_LICENSES.txt')); }
		} }), /target failed|ENOENT/);
		assert.equal(await readFile(join(output, 'sota'), 'utf8'), 'last successful release');
		assert.deepEqual(await readdir(output), ['sota']); assert.deepEqual(await readdir(root), ['release']);
	});
}

test('package all publishes three binaries and their corresponding licenses together', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-package-all-')); t.after(() => rm(root, { recursive: true, force: true }));
	const output = join(root, 'release'); await mkdir(output); await writeFile(join(output, 'stale'), 'old');
	await packageAll({ outputDir: output, runTarget: candidate });
	assert.deepEqual((await readdir(output)).sort(), ['THIRD_PARTY_LICENSES-darwin-arm64.txt', 'THIRD_PARTY_LICENSES-linux-x64.txt', 'THIRD_PARTY_LICENSES-windows-x64.txt', 'sota', 'sota-linux-x64', 'sota-windows-x64.exe']);
	for (const [script, binary] of Object.entries(binaries)) { assert.equal(await readFile(join(output, binary), 'utf8'), script); }
	assert.deepEqual(await readdir(root), ['release']);
});
