/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { bundleCodypendentNode, refreshCodypendentRuntimeManifestSync, sealCodypendentNode, verifyCodypendentNode } from '../bundle-codypendent-node.mjs';

async function fixture(run) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'sota-node-seal-'));
	try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('a bad Node archive cannot replace an existing runtime', { skip: process.platform === 'win32' }, () => fixture(async directory => {
	const destination = path.join(directory, 'runtime'); await mkdir(destination);
	await writeFile(path.join(destination, 'previous'), 'keep this runtime');
	const archive = path.join(directory, 'untrusted.tar.gz'); await writeFile(archive, 'not the pinned archive');
	await assert.rejects(bundleCodypendentNode(destination, { archivePath: archive }), /archive integrity/);
	assert.equal(await readFile(path.join(destination, 'previous'), 'utf8'), 'keep this runtime');
}));

test('the runtime seal detects changed, missing and extra dependency files', () => fixture(async directory => {
	await writeFile(path.join(directory, 'module.js'), 'trusted();');
	await sealCodypendentNode(directory); await verifyCodypendentNode(directory);
	await writeFile(path.join(directory, 'module.js'), 'changed();');
	await assert.rejects(verifyCodypendentNode(directory), /sealed tree/);
	await rm(path.join(directory, 'module.js'));
	await assert.rejects(verifyCodypendentNode(directory), /sealed tree/);
	await writeFile(path.join(directory, 'module.js'), 'trusted();');
	await writeFile(path.join(directory, 'extra.js'), 'injected();');
	await assert.rejects(verifyCodypendentNode(directory), /sealed tree/);
}));

test('runtime links stay within the sealed root', { skip: process.platform === 'win32' }, () => fixture(async directory => {
	const root = path.join(directory, 'runtime'); await mkdir(root);
	await writeFile(path.join(root, 'module.js'), 'trusted();');
	await symlink('module.js', path.join(root, 'alias.js'));
	await sealCodypendentNode(root); await verifyCodypendentNode(root);
	await writeFile(path.join(directory, 'outside.js'), 'outside();');
	await symlink('../outside.js', path.join(root, 'escape.js'));
	await assert.rejects(sealCodypendentNode(root), /escapes its root/);
	await assert.rejects(verifyCodypendentNode(root), /escapes its root/);
}));

test('signing refreshes native hashes while preserving authenticated JavaScript resources', () => fixture(async directory => {
	const root = path.join(directory, 'node-runtime'); await mkdir(path.join(root, 'bin'), { recursive: true });
	await writeFile(path.join(root, 'bin/node'), 'original Node binary');
	await writeFile(path.join(root, 'module.js'), 'trusted();');
	await writeFile(path.join(directory, 'codypendent'), 'original CLI binary');
	await sealCodypendentNode(root);
	const digest = bytes => createHash('sha256').update(bytes).digest('hex');
	const nodeRuntime = { sealSha256: digest(await readFile(path.join(root, '.codypendent-runtime-seal.json'))) };
	const manifest = { sourceSha256: 'preserve-source-provenance', files: [{ name: 'codypendent', sha256: 'before-signing' }], nodeRuntime };
	await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
	await writeFile(path.join(root, 'bin/node'), 'signed Node binary');
	await writeFile(path.join(directory, 'codypendent'), 'signed CLI binary');
	refreshCodypendentRuntimeManifestSync(directory);
	const signed = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
	await verifyCodypendentNode(root, signed.nodeRuntime);
	assert.equal(signed.files[0].sha256, digest('signed CLI binary'));
	assert.equal(signed.sourceSha256, manifest.sourceSha256);
	assert.notEqual(signed.nodeRuntime.sealSha256, nodeRuntime.sealSha256);
	await writeFile(path.join(root, 'module.js'), 'unexpected();');
	assert.throws(() => refreshCodypendentRuntimeManifestSync(directory), /Unexpected Node runtime resource modification/);
}));
