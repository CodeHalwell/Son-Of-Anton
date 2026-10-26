/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPermissions } from './install-permissions.mjs';
import { withStagedDirectory } from './staged-directory.mjs';

const version = '22.22.0';
const sealName = '.codypendent-runtime-seal.json';
// Official https://nodejs.org/dist/v22.22.0/SHASUMS256.txt.
const checksums = {
	'linux-x64': 'c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744',
	'darwin-x64': '5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce',
	'darwin-arm64': '5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function entries(root) {
	const canonical = fs.realpathSync(root), result = [];
	function visit(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name), relative = path.relative(canonical, file).split(path.sep).join('/');
			if (relative === sealName) { continue; }
			if (entry.isDirectory()) { visit(file); }
			else if (entry.isSymbolicLink()) {
				const target = fs.realpathSync(file);
				assert.ok(target.startsWith(canonical + path.sep), `Node runtime link escapes its root: ${relative}`);
				result.push({ kind: 'link', path: relative, digest: fs.readlinkSync(file) });
			} else {
				assert.ok(entry.isFile(), `Unsupported Node runtime entry: ${relative}`);
				result.push({ kind: 'file', path: relative, digest: sha256(fs.readFileSync(file)) });
			}
		}
	}
	visit(canonical);
	return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Use the daemon's sealed file/link format, including all runtime licenses. */
export async function sealCodypendentNode(root) {
	await writeFile(path.join(root, sealName), JSON.stringify(entries(root)));
}

/** Check the installed tree as well as the original downloaded archive. */
export async function verifyCodypendentNode(root, metadata) {
	const seal = await readFile(path.join(root, sealName));
	if (metadata) { assert.equal(sha256(seal), metadata.sealSha256, 'Node runtime seal integrity'); }
	assert.deepEqual(entries(root), JSON.parse(seal.toString()), 'Node runtime files differ from the sealed tree');
}

/** Signing changes Mach-O bytes. Refresh before the enclosing app is signed. */
export function refreshCodypendentRuntimeManifestSync(directory) {
	const manifestPath = path.join(directory, 'manifest.json');
	let manifest;
	try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
	catch (error) { if (error.code === 'ENOENT') { return false; } throw error; }
	for (const file of manifest.files) {
		assert.equal(path.basename(file.name), file.name, 'Native runtime file name');
		file.sha256 = sha256(fs.readFileSync(path.join(directory, file.name)));
	}
	if (manifest.nodeRuntime) {
		const root = path.join(directory, 'node-runtime'), previous = fs.readFileSync(path.join(root, sealName));
		assert.equal(sha256(previous), manifest.nodeRuntime.sealSha256, 'Node runtime seal integrity before signing');
		const after = entries(root), before = JSON.parse(previous.toString());
		const withoutSignature = list => list.map(entry => entry.kind === 'file' && entry.path === 'bin/node' ? { ...entry, digest: '' } : entry);
		assert.deepEqual(withoutSignature(after), withoutSignature(before), 'Unexpected Node runtime resource modification during signing');
		const seal = JSON.stringify(after);
		fs.writeFileSync(path.join(root, sealName), seal);
		manifest.nodeRuntime.sealSha256 = sha256(seal);
	}
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
	return true;
}

/** Build a self-contained Node tree; release workers never use PATH Node. */
export async function bundleCodypendentNode(destination, options = {}) {
	const target = `${process.platform}-${process.arch}`, checksum = checksums[target];
	assert.ok(checksum, `Unsupported Codypendent Node runtime target: ${target}`);
	const archiveName = `node-v${version}-${target}.tar.gz`;
	const cache = fileURLToPath(new URL('../.build/codypendent-node/', import.meta.url));
	const archive = options.archivePath || process.env.CODYPENDENT_NODE_ARCHIVE || path.join(cache, archiveName);
	if (!options.archivePath && !process.env.CODYPENDENT_NODE_ARCHIVE) {
		await mkdir(cache, { recursive: true });
		let present = false;
		try { present = sha256(await readFile(archive)) === checksum; } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
		if (!present) {
			const temporary = `${archive}.${process.pid}.tmp`;
			try {
				execFileSync('curl', ['--fail', '--silent', '--show-error', '--location', '--retry', '3', '--connect-timeout', '20', '--max-time', '300', '--output', temporary, `https://nodejs.org/dist/v${version}/${archiveName}`], { stdio: 'inherit' });
				assert.equal(sha256(await readFile(temporary)), checksum, 'Downloaded Node runtime archive integrity');
				await rename(temporary, archive);
			} finally { await rm(temporary, { force: true }); }
		}
	}
	assert.equal(sha256(await readFile(archive)), checksum, 'Node runtime archive integrity');
	await withStagedDirectory(destination, async staged => {
		const tar = await import('tar');
		await tar.x({ file: archive, cwd: staged, strip: 1, strict: true });
		await installPermissions(staged);
		assert.equal(execFileSync(path.join(staged, 'bin/node'), ['--version'], { encoding: 'utf8' }).trim(), `v${version}`);
		assert.ok((await readFile(path.join(staged, 'LICENSE'))).length, 'Node runtime license');
		await sealCodypendentNode(staged);
		await verifyCodypendentNode(staged);
	});
	return { version, target, archive: archiveName, archiveSha256: checksum, sealSha256: sha256(await readFile(path.join(destination, sealName))) };
}
