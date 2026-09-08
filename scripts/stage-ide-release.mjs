/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(path.join(root, 'package.json'))).version;
const directory = path.join(root, '.build/downloaded-ide'), output = path.join(root, '.build/publish-ide');
await mkdir(output); // Refuse to reuse a directory containing stale release assets.
const expected = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'];
const entries = (await readdir(directory)).sort();
assert.deepEqual(entries, expected.map(target => `ide-${target}`).sort());
const checksums = [], builds = [];
const channel = process.env.SOTA_RELEASE_CHANNEL || 'preview';
assert.ok(['stable', 'preview'].includes(channel), 'Invalid release channel');
for (const target of expected) {
	const source = path.join(directory, `ide-${target}`), manifest = JSON.parse(await readFile(path.join(source, 'manifest.json')));
	assert.equal(manifest.target, target); assert.equal(manifest.ideVersion, version); assert.equal(manifest.commit, process.env.GITHUB_SHA);
	const report = JSON.parse(await readFile(path.join(source, 'installation-report.json')));
	assert.deepEqual([report.success, report.commit, report.target, report.ideVersion], [true, manifest.commit, target, version]);
	const suffixes = target.startsWith('darwin') ? ['.dmg', '.zip'] : target.startsWith('win32') ? ['-setup.exe', '.zip'] : ['.deb', '.tar.gz'];
	assert.deepEqual(manifest.files.map(file => file.name).sort(), suffixes.map(suffix => `son-of-anton-${version}-${target}${suffix}`).sort(), 'Missing or unexpected installers');
	for (const file of manifest.files) {
		assert.equal(file.name, path.basename(file.name)); assert.ok(file.name.startsWith(`son-of-anton-${version}-${target}`));
		assert.ok(!checksums.some(item => item.name === file.name), 'Duplicate release asset');
		const bytes = await readFile(path.join(source, file.name)); assert.equal(bytes.length, file.bytes);
		assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
		await copyFile(path.join(source, file.name), path.join(output, file.name)); checksums.push(file);
	}
	if (channel === 'stable') {
		if (target.startsWith('darwin')) { assert.equal(manifest.signing, 'developer-id-notarized', 'Stable macOS releases require notarization'); }
		if (target.startsWith('win32')) { assert.equal(manifest.signing, 'authenticode', 'Stable Windows releases require signing'); }
	}
	builds.push(manifest); await copyFile(path.join(source, 'installation-report.json'), path.join(output, `installation-${target}.json`));
}
await writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.map(file => `${file.sha256}  ${file.name}\n`).join(''));
await writeFile(path.join(output, 'build-manifest.json'), JSON.stringify({ version: 1, channel, ideVersion: version, commit: process.env.GITHUB_SHA, builds }, null, 2) + '\n');
await copyFile(path.join(root, 'docs/installation.md'), path.join(output, 'INSTALLATION.md'));
console.log(`Verified ${checksums.length} installers from ${builds.length} native builds.`);
