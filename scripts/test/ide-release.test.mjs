/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function fixture(t, mutate = () => {}) {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-release-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, 'scripts')); await mkdir(path.join(root, 'docs'));
	await cp(new URL('../stage-ide-release.mjs', import.meta.url), path.join(root, 'scripts/stage-ide-release.mjs'));
	await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
	await writeFile(path.join(root, 'docs/installation.md'), 'Installation fixture');
	for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
		const folder = path.join(root, '.build/downloaded-ide', `ide-${target}`); await mkdir(folder, { recursive: true });
		const suffixes = target.startsWith('darwin') ? ['.dmg', '.zip'] : target.startsWith('win32') ? ['-setup.exe', '.zip'] : ['.deb', '.tar.gz'];
		const files = [];
		for (const suffix of suffixes) {
			const name = `son-of-anton-1.2.3-${target}${suffix}`, bytes = Buffer.from(name);
			await writeFile(path.join(folder, name), bytes); files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
		}
		const manifest = { target, ideVersion: '1.2.3', commit: 'fixture-commit', files };
		const report = { success: true, target, ideVersion: '1.2.3', commit: 'fixture-commit' };
		if (target === 'linux-x64') { await mutate({ manifest, report, folder }); }
		await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
		await writeFile(path.join(folder, 'installation-report.json'), JSON.stringify(report));
	}
	return { root, run: () => spawnSync(process.execPath, [path.join(root, 'scripts/stage-ide-release.mjs')], { env: { ...process.env, GITHUB_SHA: 'fixture-commit' }, encoding: 'utf8' }) };
}

test('release staging verifies all eight installers and refuses stale output', async t => {
	const { root, run } = await fixture(t);
	const result = run(); assert.equal(result.status, 0, result.stderr);
	const sums = await readFile(path.join(root, '.build/publish-ide/SHA256SUMS.txt'), 'utf8'); assert.equal(sums.trim().split('\n').length, 8);
	assert.notEqual(run().status, 0);
});
for (const [name, mutate] of [
	['mixed source commit', ({ manifest }) => { manifest.commit = 'different'; }],
	['failed installation', ({ report }) => { report.success = false; }],
	['wrong native platform', ({ report }) => { report.target = 'darwin-arm64'; }],
	['missing installer', ({ manifest }) => { manifest.files.pop(); }],
	['tampered bytes', async ({ manifest, folder }) => { await writeFile(path.join(folder, manifest.files[0].name), 'tampered'); }],
]) {
	test(`release staging rejects ${name}`, async t => { const { run } = await fixture(t, mutate); assert.notEqual(run().status, 0); });
}
