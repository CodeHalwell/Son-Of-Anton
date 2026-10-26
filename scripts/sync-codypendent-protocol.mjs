/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit source checkout; a normal Anton build never needs a sibling repo.
const sourceIndex = process.argv.indexOf('--source');
if (sourceIndex < 0 || !process.argv[sourceIndex + 1]) { throw new Error('Usage: node scripts/sync-codypendent-protocol.mjs --source /path/to/codypendent'); }
const source = path.resolve(process.argv[sourceIndex + 1]);
const root = fileURLToPath(new URL('../', import.meta.url));
const sdk = path.join(source, 'sdk/protocol');
const destination = path.join(root, 'extensions/son-of-anton-daemon/vendor');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npm, ['run', 'build'], { cwd: sdk, stdio: 'inherit' });
await mkdir(destination, { recursive: true });
const [packed] = JSON.parse(execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: sdk, encoding: 'utf8' }));
const files = [];
async function collect(directory, prefix = '') {
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
		const relative = `${prefix}${entry.name}`;
		if (entry.isDirectory()) { await collect(path.join(directory, entry.name), `${relative}/`); }
		else { files.push([relative, await readFile(path.join(directory, entry.name))]); }
	}
}
await collect(path.join(sdk, 'src'));
const sourceHash = createHash('sha256');
for (const [name, bytes] of files) { sourceHash.update(name).update('\0').update(bytes).update('\0'); }
await cp(path.join(sdk, 'LICENSE'), path.join(destination, 'LICENSE'));
await writeFile(path.join(destination, 'UPSTREAM.json'), JSON.stringify({
	package: packed.name, version: packed.version, archive: packed.filename,
	repository: 'https://github.com/CodeHalwell/codypendent',
	baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
	includesLocalChanges: !!execFileSync('git', ['status', '--porcelain', '--', 'sdk/protocol'], { cwd: source, encoding: 'utf8' }).trim(),
	sourceSha256: sourceHash.digest('hex'),
	archiveSha256: createHash('sha256').update(await readFile(path.join(destination, packed.filename))).digest('hex'),
	integrity: packed.integrity,
}, null, '\t') + '\n');
for (const name of ['son-of-anton', 'son-of-anton-daemon']) {
	const directory = path.join(root, 'extensions', name);
	const dependency = name === 'son-of-anton-daemon' ? `file:vendor/${packed.filename}` : `file:../son-of-anton-daemon/vendor/${packed.filename}`;
	const manifestPath = path.join(directory, 'package.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	manifest.dependencies[packed.name] = dependency;
	await writeFile(manifestPath, JSON.stringify(manifest, null, name === 'son-of-anton' ? '\t' : 2) + '\n');
	const lockPath = path.join(directory, 'package-lock.json');
	const lock = JSON.parse(await readFile(lockPath, 'utf8'));
	lock.packages[''].dependencies[packed.name] = dependency;
	lock.packages[`node_modules/${packed.name}`] = { version: packed.version, resolved: dependency, integrity: packed.integrity, license: 'MIT' };
	await writeFile(lockPath, JSON.stringify(lock, null, name === 'son-of-anton' ? '\t' : 2) + '\n');
}
console.log(`Vendored ${packed.name}@${packed.version}; build and install from the committed archive.`);
