/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { GitSnapshotStore } from './GitSnapshotStore';

describe('Git workspace checkpoints', () => {
	let root: string;
	let store: GitSnapshotStore;
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const write = (file: string, text: string) => fs.writeFile(path.join(root, file), text);
	const read = (file: string) => fs.readFile(path.join(root, file), 'utf8');
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'sota-snapshot-test-'));
		git('init', '-q');
		git('config', 'user.name', 'Test');
		git('config', 'user.email', 'test@example.invalid');
		await write('file.txt', 'original');
		await write('.gitignore', 'ignored\n');
		git('add', '.');
		git('commit', '-qm', 'initial');
		store = new GitSnapshotStore(root);
	});
	afterEach(async () => fs.rm(root, { recursive: true, force: true }));

	test('clean capture restores edits and removes newly created files without moving HEAD', async () => {
		const head = git('rev-parse', 'HEAD');
		const snapshot = await store.capture();
		await write('file.txt', 'agent edit');
		await write('new.txt', 'agent file');
		let preview: readonly string[] = [];
		const recovery = await store.restore(snapshot, async files => { preview = files; return true; });
		assert.deepEqual({ text: await read('file.txt'), status: git('status', '--porcelain'), head: git('rev-parse', 'HEAD'), stash: git('stash', 'list'), preview }, {
			text: 'original', status: '', head, stash: '', preview: ['file.txt', 'new.txt'],
		});
		assert.ok(recovery);
		await store.restore(recovery, async () => true);
		assert.deepEqual([await read('file.txt'), await read('new.txt')], ['agent edit', 'agent file']);
	});

	test('dirty capture preserves staged, unstaged and non-ignored untracked states', async () => {
		await write('file.txt', 'staged');
		git('add', 'file.txt');
		await write('file.txt', 'unstaged');
		await write('scratch.txt', 'untracked');
		await write('ignored', 'private');
		const before = git('status', '--porcelain');
		const snapshot = await store.capture();
		assert.equal(git('status', '--porcelain'), before);
		await write('file.txt', 'later');
		await fs.unlink(path.join(root, 'scratch.txt'));
		await store.restore(snapshot, async () => true);
		assert.deepEqual({ working: await read('file.txt'), staged: git('show', ':file.txt'), untracked: await read('scratch.txt'), ignored: await read('ignored'), status: git('status', '--porcelain') }, {
			working: 'unstaged', staged: 'staged', untracked: 'untracked', ignored: 'private', status: before,
		});
	});

	test('retained snapshots survive Git garbage collection', async () => {
		await write('file.txt', 'snapshot');
		const snapshot = await store.capture();
		await write('file.txt', 'after');
		git('gc', '--prune=now');
		await store.restore(snapshot, async () => true);
		assert.equal(await read('file.txt'), 'snapshot');
	});

	test('different worktrees and changed HEAD are rejected before confirmation', async () => {
		const snapshot = await store.capture();
		let asked = false;
		await assert.rejects(store.restore({ ...snapshot, workspaceRoot: path.join(root, 'other') }, async () => { asked = true; return true; }), /different Git worktree/);
		git('commit', '--allow-empty', '-qm', 'new head');
		await assert.rejects(store.restore(snapshot, async () => { asked = true; return true; }), /HEAD changed/);
		assert.equal(asked, false);
	});

	test('edits during confirmation abort without losing the new edits', async () => {
		const snapshot = await store.capture();
		await assert.rejects(store.restore(snapshot, async () => { await write('file.txt', 'during prompt'); return true; }), /Files changed while confirming/);
		assert.equal(await read('file.txt'), 'during prompt');
	});

	test('declining restore preserves the workspace and releases its preview snapshot', async () => {
		const snapshot = await store.capture();
		await write('file.txt', 'keep');
		const refs = git('for-each-ref', '--format=%(refname)', 'refs/son-of-anton');
		assert.equal(await store.restore(snapshot, async () => false), undefined);
		assert.deepEqual([await read('file.txt'), git('for-each-ref', '--format=%(refname)', 'refs/son-of-anton')], ['keep', refs]);
	});
});
