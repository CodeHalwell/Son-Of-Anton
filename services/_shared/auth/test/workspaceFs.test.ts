/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { workspacePath, readWorkspaceFile, writeWorkspaceFile, removeWorkspaceFile } from '../workspaceFs';

test('workspace operations reject traversal and symlinks, including missing children', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sota-path-test-'));
	const root = path.join(directory, 'project');
	const outside = path.join(directory, 'project-sibling');
	await fs.mkdir(root);
	await fs.mkdir(outside);
	await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
	try {
		for (const invalid of ['../project-sibling/secret.txt', path.join(outside, 'secret.txt'), '../project-sibling/new/file.txt', root]) {
			await assert.rejects(workspacePath(root, invalid));
		}
		await fs.symlink(outside, path.join(root, 'link'), 'junction');
		await assert.rejects(readWorkspaceFile(root, 'link/secret.txt'), /Symlinks/);
		await assert.rejects(writeWorkspaceFile(root, 'link/new/file.txt', 'overwrite'), /Symlinks/);
		await assert.rejects(removeWorkspaceFile(root, 'link/secret.txt'), /Symlinks/);
		assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
		await writeWorkspaceFile(root, 'nested/new.txt', 'inside');
		assert.equal(await readWorkspaceFile(root, 'nested/new.txt'), 'inside');
		if (process.platform !== 'win32') {
			await fs.chmod(path.join(root, 'nested/new.txt'), 0o755);
			await writeWorkspaceFile(root, 'nested/new.txt', 'updated');
			assert.equal((await fs.stat(path.join(root, 'nested/new.txt'))).mode & 0o777, 0o755);
		}
		assert.equal(await readWorkspaceFile(root, 'missing/absent.txt'), undefined);
		await removeWorkspaceFile(root, 'nested/new.txt');
		assert.equal(await readWorkspaceFile(root, 'nested/new.txt'), undefined);
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
});
