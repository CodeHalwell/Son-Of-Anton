/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installPermissions } from '../install-permissions.mjs';

test('private build permissions become readable installation assets without retaining set-id bits', { skip: process.platform === 'win32' }, async t => {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-install-permissions-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const app = path.join(root, 'app'), child = path.join(app, 'resources');
	await mkdir(child, { recursive: true });
	const data = path.join(child, 'data.json'), binary = path.join(app, 'program');
	await writeFile(data, '{}'); await writeFile(binary, 'fixture');
	await chmod(app, 0o700); await chmod(child, 0o700); await chmod(data, 0o600); await chmod(binary, 0o4750);
	await installPermissions(app);
	assert.deepEqual(await Promise.all([app, child, data, binary].map(async file => (await lstat(file)).mode & 0o7777)), [0o755, 0o755, 0o644, 0o755]);
});

test('normalization does not follow artifact symlinks into private files', { skip: process.platform === 'win32' }, async t => {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-install-links-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const app = path.join(root, 'app'), outside = path.join(root, 'private.txt');
	await mkdir(app); await writeFile(outside, 'private'); await chmod(outside, 0o600);
	const link = path.join(app, 'link'); await symlink(outside, link);
	await installPermissions(app);
	assert.equal((await lstat(outside)).mode & 0o777, 0o600);
	assert.equal((await lstat(link)).isSymbolicLink(), true);
	await assert.rejects(installPermissions(link), /root must be a directory/);
});
