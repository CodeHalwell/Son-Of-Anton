/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const index = process.argv.indexOf('--source');
if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/sync-codypendent-runtime.mjs --source /path/to/codypendent');
const source = path.resolve(process.argv[index + 1]);
const destination = fileURLToPath(new URL('../build/codypendent/vendor/', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' }).split('\0').filter(Boolean);
const addedSources = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: source, encoding: 'utf8' })
	.split('\0').filter(name => /^crates\/.*\.rs$/.test(name));
// Explicit build-input roots. Never collect an entire working tree or local configuration.
const allowed = name => ['Cargo.toml', 'Cargo.lock', 'LICENSE', 'rust-toolchain.toml'].includes(name)
	|| /^(crates|migrations|docs\/specs|sdk\/wasm)\//.test(name);
const files = [...new Set([...tracked.filter(allowed), ...addedSources])].sort();
const digest = createHash('sha256');
for (const file of files) {
	if (!(await lstat(path.join(source, file))).isFile()) throw new Error(`Runtime source must be a regular file: ${file}`);
	digest.update(file).update('\0').update(await readFile(path.join(source, file))).update('\0');
}
const sourceSha256 = digest.digest('hex');
await mkdir(destination, { recursive: true });
const archive = 'codypendent-source.tar.gz';
await tar.c({ cwd: source, file: path.join(destination, archive), portable: true, mtime: new Date(0), gzip: true }, files);
const manifest = await readFile(path.join(source, 'Cargo.toml'), 'utf8');
const version = manifest.match(/\[workspace.package\]\s*version = "([^"]+)"/)?.[1];
if (!version) throw new Error('No Codypendent workspace version.');
await copyFile(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ version, archive, sourceSha256,
	archiveSha256: createHash('sha256').update(await readFile(path.join(destination, archive))).digest('hex'),
	repository: 'https://github.com/CodeHalwell/codypendent',
	baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
	includesLocalChanges: !!execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: source, encoding: 'utf8' }).trim(),
	files: files.length,
}, null, '\t') + '\n');
console.log(`Vendored Codypendent ${version}: ${files.length} build inputs, ${sourceSha256}`);
