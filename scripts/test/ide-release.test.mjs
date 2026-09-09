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
import { ideReleasePolicy, ideReleasePublicationFlags } from '../ide-release-policy.mjs';

async function fixture(t, mutate = () => {}, mutateAll = () => {}, version = '1.2.3') {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-release-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, 'scripts')); await mkdir(path.join(root, 'docs'));
	await cp(new URL('../stage-ide-release.mjs', import.meta.url), path.join(root, 'scripts/stage-ide-release.mjs'));
	await cp(new URL('../ide-release-policy.mjs', import.meta.url), path.join(root, 'scripts/ide-release-policy.mjs'));
	await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
	await writeFile(path.join(root, 'docs/installation.md'), 'Installation fixture');
	for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) {
		const folder = path.join(root, '.build/downloaded-ide', `ide-${target}`); await mkdir(folder, { recursive: true });
		const suffixes = target.startsWith('darwin') ? ['.dmg', '.zip'] : target.startsWith('win32') ? ['-setup.exe', '.zip'] : ['.deb', '.tar.gz'];
		const files = [];
		for (const suffix of suffixes) {
			const name = `son-of-anton-${version}-${target}${suffix}`, bytes = Buffer.from(name);
			await writeFile(path.join(folder, name), bytes); files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
		}
		const manifest = { target, ideVersion: version, commit: 'fixture-commit', signing: target.startsWith('darwin') ? 'developer-id-notarized' : target.startsWith('win32') ? 'authenticode' : 'unsigned', files };
		await mutateAll(manifest);
		const report = { success: true, target, ideVersion: version, commit: 'fixture-commit' };
		if (target === 'linux-x64') { await mutate({ manifest, report, folder }); }
		await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
		await writeFile(path.join(folder, 'installation-report.json'), JSON.stringify(report));
	}
	return { root, run: (env = {}) => spawnSync(process.execPath, [path.join(root, 'scripts/stage-ide-release.mjs')], { env: { ...process.env, GITHUB_SHA: 'fixture-commit', GITHUB_REF: '', SOTA_RELEASE_CHANNEL: '', ...env }, encoding: 'utf8' }) };
}

test('every version suffix is preview across channel, signing and publication decisions', () => {
	for (const suffix of ['dev', 'nightly', 'canary.7', 'custom-build', 'preview', 'rc.1', 'beta', 'alpha']) {
		const version = `1.113.0-${suffix}`, ref = `refs/tags/ide-v${version}`;
		assert.deepEqual(ideReleasePolicy(version, { ref }), { channel: 'preview', requireSigning: false });
		assert.deepEqual(ideReleasePolicy(version, { ref, channel: 'stable' }), { channel: 'preview', requireSigning: false });
		assert.deepEqual(ideReleasePolicy(version, { ref, requireSigning: 'true' }), { channel: 'preview', requireSigning: true });
		assert.deepEqual(ideReleasePublicationFlags(version, 'preview'), ['--prerelease']);
		assert.throws(() => ideReleasePublicationFlags(version, 'stable'), /cannot be published as stable/);
	}
	assert.deepEqual(ideReleasePolicy('1.113.0', { ref: 'refs/tags/ide-v1.113.0' }), { channel: 'stable', requireSigning: true });
	assert.deepEqual(ideReleasePolicy('1.113.0', { ref: 'refs/heads/main' }), { channel: 'preview', requireSigning: false });
	assert.deepEqual(ideReleasePolicy('1.113.0', { channel: 'stable' }), { channel: 'stable', requireSigning: true });
	assert.deepEqual(ideReleasePolicy('1.113.0', { ref: 'refs/tags/ide-v1.113.0', channel: 'preview' }), { channel: 'preview', requireSigning: false });
	assert.deepEqual(ideReleasePublicationFlags('1.113.0', 'stable'), []);
	assert.throws(() => ideReleasePolicy('1.113.0-dev', { ref: 'refs/tags/ide-v1.113.0' }), /must match/);
});

test('dev and nightly staging cannot emit a stable manifest even when explicitly requested', async t => {
	for (const suffix of ['dev', 'nightly']) {
		const version = `1.113.0-${suffix}`;
		const preview = await fixture(t, () => {}, build => { build.signing = 'unsigned'; }, version);
		const result = preview.run({ SOTA_RELEASE_CHANNEL: 'stable', GITHUB_REF: `refs/tags/ide-v${version}` });
		assert.equal(result.status, 0, result.stderr);
		const manifest = JSON.parse(await readFile(path.join(preview.root, '.build/publish-ide/build-manifest.json'), 'utf8'));
		assert.deepEqual([manifest.ideVersion, manifest.channel, ideReleasePublicationFlags(manifest.ideVersion, manifest.channel)], [version, 'preview', ['--prerelease']]);
	}
});

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


test('stable staging requires every native signing gate and records the channel', async t => {
	const signed = await fixture(t);
	assert.equal(signed.run({ SOTA_RELEASE_CHANNEL: 'stable' }).status, 0);
	const manifest = JSON.parse(await readFile(path.join(signed.root, '.build/publish-ide/build-manifest.json'), 'utf8'));
	assert.equal(manifest.channel, 'stable');
	const unsigned = await fixture(t, () => {}, build => { if (build.target === 'darwin-arm64') { build.signing = 'developer-id'; } });
	assert.notEqual(unsigned.run({ SOTA_RELEASE_CHANNEL: 'stable' }).status, 0);
});
