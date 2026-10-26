/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, copyFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';
import { withStagedDirectory } from './staged-directory.mjs';
import { bundleCodypendentNode } from './bundle-codypendent-node.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = path.join(root, 'build/codypendent/vendor');
const manifest = JSON.parse(await readFile(path.join(vendor, 'manifest.json'), 'utf8'));
assert.equal(path.basename(manifest.archive), manifest.archive);
const archive = path.join(vendor, manifest.archive);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256(await readFile(archive)), manifest.archiveSha256, 'Runtime source archive integrity');
if (process.argv.includes('--verify-only')) { console.log('Codypendent source integrity verified.'); process.exit(0); }
if (process.platform === 'win32') { console.log('Codypendent shared runtime supports Linux and macOS. Windows uses the native compatibility runtime.'); process.exit(0); }
const source = path.join(root, '.build/codypendent-source', manifest.archiveSha256);
// Replace the extraction atomically: retries cannot retain extra files from
// an interrupted or modified checkout with this archive's content-addressed name.
await withStagedDirectory(source, staged => tar.x({ cwd: staged, file: archive, strict: true, filter: (name, entry) => {
	assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..') && entry.type === 'File', `Invalid runtime input: ${name}`);
	return true;
} }));
const target = path.join(root, '.build/codypendent-target');
const debug = process.argv.includes('--debug');
const supplied = process.argv.indexOf('--binary');
let binary;
let launcher;
if (supplied >= 0) {
	assert.ok(debug, '--binary is restricted to local debug verification');
	binary = path.resolve(process.argv[supplied + 1]);
} else {
	execFileSync('cargo', ['build', '--locked', ...(!debug ? ['--release'] : []), '-p', 'codypendent-cli', '--bin', 'codypendent',
		'-p', 'codypendent-ui-worker-launcher', '--bin', 'codypendent-ui-worker-launcher'], {
		cwd: source, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target, CODYPENDENT_BUILD_ID: manifest.sourceSha256 },
	});
	binary = path.join(target, debug ? 'debug' : 'release', 'codypendent');
	launcher = path.join(target, debug ? 'debug' : 'release', 'codypendent-ui-worker-launcher');
}
assert.match(execFileSync(binary, ['--version'], { encoding: 'utf8' }), new RegExp(`^codypendent ${manifest.version.replaceAll('.', '\\.')}\\b`));
const destination = path.join(root, 'extensions/son-of-anton-daemon/runtime/codypendent');
await withStagedDirectory(destination, async staged => {
	const files = [];
	for (const [name, from] of [['codypendent', binary], ['codypendent-ui-worker-launcher', launcher]]) {
		if (!from) { continue; }
		await copyFile(from, path.join(staged, name)); await chmod(path.join(staged, name), 0o755);
		files.push({ name, sha256: sha256(await readFile(from)) });
	}
	await copyFile(path.join(vendor, 'LICENSE'), path.join(staged, 'LICENSE'));
	const nodeRuntime = await bundleCodypendentNode(path.join(staged, 'node-runtime'));
	await writeFile(path.join(staged, 'manifest.json'), JSON.stringify({ version: manifest.version, platform: process.platform, arch: process.arch,
		profile: debug ? 'debug' : 'release', sourceSha256: manifest.sourceSha256, archiveSha256: manifest.archiveSha256, files, nodeRuntime,
	}, null, '\t') + '\n');
});
console.log(`Codypendent runtime: ${destination}`);
