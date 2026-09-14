/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { IsolatedWorkspace } from './IsolatedWorkspace';
import { GitSnapshotStore } from '../checkpoint/GitSnapshotStore';

describe('retained isolated proposals', () => {
	let directory: string, root: string, store: IsolatedWorkspace;
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	beforeEach(async () => {
		directory = await realpath(await mkdtemp(join(tmpdir(), 'sota-proposal-test-'))); root = join(directory, 'repo');
		await import('node:fs/promises').then(fs => fs.mkdir(root));
		git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
		git('config', 'core.autocrlf', 'false');
		await writeFile(join(root, 'a.txt'), 'original\n'); await writeFile(join(root, 'b.txt'), 'other\n');
		git('add', '.'); git('commit', '-qm', 'fixture'); store = new IsolatedWorkspace(join(directory, 'proposals'));
	});
	afterEach(async () => { await rm(directory, { force: true, recursive: true }); });
	test('review and application preserve dirty index, HEAD and unrelated work; checkpoint restores', async () => {
		await writeFile(join(root, 'a.txt'), 'staged\n'); git('add', 'a.txt'); await writeFile(join(root, 'a.txt'), 'unstaged\n');
		await writeFile(join(root, 'scratch.txt'), 'keep\n'); const head = git('rev-parse', 'HEAD');
		const proposal = await store.create(root);
		assert.equal(await readFile(join(proposal.worktree, 'a.txt'), 'utf8'), 'unstaged\n');
		await writeFile(join(proposal.worktree, 'a.txt'), 'fixed\n'); await writeFile(join(proposal.worktree, process.platform === 'win32' ? 'new file.txt' : 'new\nfile.txt'), 'new\n');
		const review = await store.finish(proposal.id, 'review');
		assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'unstaged\n');
		const result = await store.apply(review.id, review.digest!);
		assert.deepEqual([git('rev-parse', 'HEAD'), git('show', ':a.txt'), await readFile(join(root, 'a.txt'), 'utf8'), await readFile(join(root, 'scratch.txt'), 'utf8')], [head, 'staged', 'fixed\n', 'keep\n']);
		await new GitSnapshotStore(root).restore(result.recovery!, async () => true);
		assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'unstaged\n');
	});
	test('concurrent edits reject application and retain the proposal', async () => {
		const proposal = await store.create(root); await writeFile(join(proposal.worktree, 'a.txt'), 'agent\n');
		const review = await store.finish(proposal.id, 'review'); await writeFile(join(root, 'a.txt'), 'user\n');
		await assert.rejects(store.apply(review.id, review.digest!), /conflict/);
		assert.deepEqual([await readFile(join(root, 'a.txt'), 'utf8'), await readFile(join(proposal.worktree, 'a.txt'), 'utf8')], ['user\n', 'agent\n']);
	});
	test('non-overlapping concurrent proposals apply without merges', async () => {
		const first = await store.create(root), second = await store.create(root);
		await writeFile(join(first.worktree, 'a.txt'), 'first\n'); await writeFile(join(second.worktree, 'b.txt'), 'second\n');
		for (const proposal of [first, second]) { const review = await store.finish(proposal.id, 'review'); await store.apply(review.id, review.digest!); }
		assert.deepEqual([await readFile(join(root, 'a.txt'), 'utf8'), await readFile(join(root, 'b.txt'), 'utf8')], ['first\n', 'second\n']);
	});
	test('cancelled work survives restart and cannot apply until reviewed', async () => {
		const proposal = await store.create(root); await writeFile(join(proposal.worktree, 'a.txt'), 'partial\n');
		await store.finish(proposal.id, 'cancelled'); const restarted = new IsolatedWorkspace(store.directory); const saved = await restarted.load(proposal.id);
		await assert.rejects(restarted.apply(saved.id, saved.digest!), /reviewed/);
		assert.deepEqual([saved.status, await readFile(join(saved.worktree, 'a.txt'), 'utf8')], ['cancelled', 'partial\n']);
	});
	test('tampered patch is rejected before any write', async () => {
		const proposal = await store.create(root); await writeFile(join(proposal.worktree, 'a.txt'), 'agent\n'); const review = await store.finish(proposal.id, 'review');
		await writeFile(store.patchPath(review.id), 'tampered'); await assert.rejects(store.apply(review.id, review.digest!), /changed since review/);
		assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'original\n');
	});
	test('active application claims block writes and crashed claims do not block recovery', async () => {
		const proposal = await store.create(root); await writeFile(join(proposal.worktree, 'a.txt'), 'agent\n'); const review = await store.finish(proposal.id, 'review');
		const directory = git('rev-parse', '--absolute-git-dir');
		const active = join(directory, `son-of-anton-apply-${process.pid}-00000000-0000-0000-0000-000000000000.lock`);
		await writeFile(active, ''); await assert.rejects(store.apply(review.id, review.digest!), /operation is in progress/);
		await rm(active);
		await writeFile(join(directory, 'son-of-anton-apply-2147483647-00000000-0000-0000-0000-000000000000.lock'), '');
		assert.equal((await store.apply(review.id, review.digest!)).status, 'applied');
	});
});
