/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CheckpointIndexStorage } from './CheckpointIndexStorage';
import { CheckpointManager, type Checkpoint } from './CheckpointManager';
import { FileSnapshotStore, type FileSnapshot } from './FileSnapshotStore';
import type { ConfigStore, MementoStore } from '../host';

function snapshotDirectory(snapshot: FileSnapshot): string {
	return join(snapshot.storageRoot, createHash('sha256').update(snapshot.workspaceRoot).digest('hex'), snapshot.id);
}

async function captureFailureFixture(t: import('node:test').TestContext) {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-checkpoint-index-failure-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'workspace'); await fs.mkdir(root); await fs.writeFile(join(root, 'file'), Buffer.alloc(1024 * 1024, 42));
	const values = new Map<string, unknown>();
	const faults: { beforeWrite?: (checkpoints: Checkpoint[]) => Promise<void>; warn?: (message: string) => void } = {};
	const warnings: string[] = [];
	const state: MementoStore = { get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T, update: async (key, value) => { values.set(key, value); } };
	const config: ConfigStore = { get: <T>(key: string, fallback?: T) => (key === 'checkpoints.maxCount' ? 1 : fallback) as T };
	const manager = new CheckpointManager({ load: () => ({ messages: [], summary: {} }), update() {} }, state, {
		storageRoot: join(directory, 'storage'), getWorkspaceRoot: () => root, config, confirmRestore: async () => true,
		notifier: { info() {}, warn: message => { warnings.push(message); faults.warn?.(message); }, error: message => assert.fail(message) },
	});
	const index = (manager as unknown as { indexStore(): CheckpointIndexStorage }).indexStore() as unknown as { write(value: { checkpoints: Checkpoint[] }): Promise<void> };
	const write = index.write.bind(index); index.write = async value => { await faults.beforeWrite?.(value.checkpoints); await write(value); };

	t.after(() => manager.dispose());
	return { manager, faults, warnings, root, state, config, directory };
}

test('failed checkpoint indexing removes only the new file payload and repeated failures do not accumulate snapshots', async t => {
	const { manager, faults, warnings, root } = await captureFailureFixture(t);
	const shared = await manager.capture('parent', 0, 'shared'); assert.ok(shared?.fileSnapshot);
	await manager.attachToBranch(shared.id, 'branch');
	const existing = await manager.capture('other', 0, 'existing'); assert.ok(existing?.fileSnapshot);
	const indexError = Object.assign(new Error('Index persistence failed'), { code: 'ENOSPC' });
	const newlyCaptured: FileSnapshot[] = [];
	faults.beforeWrite = async checkpoints => {
		const snapshot = checkpoints.find(checkpoint => checkpoint.id !== shared.id && checkpoint.id !== existing.id)!.fileSnapshot!;
		// This is a real complete payload: failure occurs only when the host
		// attempts to index it, after capture has written its manifest and bytes.
		const manifest = JSON.parse(await fs.readFile(join(snapshotDirectory(snapshot), 'manifest.json'), 'utf8')) as { files: { digest: string }[] };
		assert.equal((await fs.stat(join(snapshotDirectory(snapshot), manifest.files[0].digest))).size, 1024 * 1024);
		newlyCaptured.push(snapshot); throw indexError;
	};
	let changes = 0; const listener = manager.onDidChange(() => { changes++; }); t.after(() => listener.dispose());
	for (let attempt = 0; attempt < 3; attempt++) { await assert.rejects(manager.capture('failing', attempt, 'fail'), error => error === indexError); }
	for (const snapshot of newlyCaptured) { await assert.rejects(fs.access(snapshotDirectory(snapshot)), { code: 'ENOENT' }); }
	const directory = dirname(snapshotDirectory(shared.fileSnapshot));
	assert.deepEqual({ snapshots: (await fs.readdir(directory)).sort(), indexed: manager.listAll().map(checkpoint => checkpoint.id).sort(), branch: manager.list('branch').map(checkpoint => checkpoint.id), changes, warnings, fileSize: (await fs.stat(join(root, 'file'))).size }, {
		snapshots: [shared.fileSnapshot.id, existing.fileSnapshot.id].sort(), indexed: [shared.id, existing.id].sort(), branch: [shared.id], changes: 0, warnings: [], fileSize: 1024 * 1024,
	});
	faults.beforeWrite = undefined;
	const recovered = await manager.capture('later', 0, 'recovered'); assert.ok(recovered?.fileSnapshot);
	assert.deepEqual((await fs.readdir(directory)).sort(), [shared.fileSnapshot.id, recovered.fileSnapshot.id].sort());
});

test('failed orphan cleanup warns without replacing the original checkpoint index error', async t => {
	const { manager, faults, warnings } = await captureFailureFixture(t);
	const indexError = new Error('Original index failure'); const cleanupError = new Error('Snapshot cleanup denied');
	let captured: FileSnapshot | undefined;
	faults.beforeWrite = async checkpoints => { captured = checkpoints[0].fileSnapshot; throw indexError; };
	t.mock.method(FileSnapshotStore.prototype, 'release', async () => { throw cleanupError; });
	await assert.rejects(manager.capture('failing', 0, 'fail'), error => error === indexError);
	assert.ok(captured); await fs.access(snapshotDirectory(captured));
	assert.deepEqual({ indexed: manager.listAll(), warnings }, { indexed: [], warnings: ['Could not release an unindexed file checkpoint: Error: Snapshot cleanup denied'] });
	faults.warn = () => { throw new Error('Notifier failure'); };
	await assert.rejects(manager.capture('failing', 1, 'fail again'), error => error === indexError);
});

test('post-commit pruning failure cannot delete the newly indexed file checkpoint', async t => {
	const { manager, faults } = await captureFailureFixture(t);
	const old = await manager.capture('parent', 0, 'old'); assert.ok(old?.fileSnapshot);
	let candidate: FileSnapshot | undefined;
	faults.beforeWrite = async checkpoints => { candidate = checkpoints[0].fileSnapshot; };
	const released: string[] = [];
	t.mock.method(FileSnapshotStore.prototype, 'release', async (snapshot: FileSnapshot) => { released.push(snapshot.id); throw new Error('Pruning cleanup failed'); });
	const notificationError = new Error('Pruning warning failed'); faults.warn = () => { throw notificationError; };
	await assert.rejects(manager.capture('parent', 1, 'new'), error => error === notificationError);
	assert.ok(candidate); await fs.access(snapshotDirectory(candidate));
	assert.deepEqual({ released, indexed: manager.listAll().map(checkpoint => checkpoint.fileSnapshot?.id) }, { released: [old.fileSnapshot.id], indexed: [candidate.id] });
});

for (const kind of ['fs', 'git'] as const) {
	test(`${kind} checkpoint releases its retained snapshot after the deleted parent's final branch is removed`, async t => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'sota-checkpoint-last-branch-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
		const root = join(directory, 'workspace'); await fs.mkdir(root); await fs.writeFile(join(root, 'file'), 'one');
		const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
		if (kind === 'git') { git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'initial'); }
		const values = new Map<string, unknown>(); const state: MementoStore = { get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T, update: async (key, value) => { values.set(key, value); } };
		const config: ConfigStore = { get: <T>(_key: string, fallback?: T) => fallback as T };
		const ids = new Set(['parent', 'first-branch', 'last-branch']);
		const conversations = { load: (id: string) => ids.has(id) ? { messages: ['turn'], summary: {} } : undefined, update() {} };
		const host = { storageRoot: join(directory, 'storage'), getWorkspaceRoot: () => root, config, confirmRestore: async () => true, notifier: { info() {}, warn(message: string) { assert.fail(message); }, error(message: string) { assert.fail(message); } } };
		const manager = new CheckpointManager(conversations, state, host); t.after(() => manager.dispose());
		const checkpoint = await manager.capture('parent', 1, 'first'); assert.ok(checkpoint);
		await manager.attachToBranch(checkpoint.id, 'first-branch'); await manager.attachToBranch(checkpoint.id, 'last-branch');
		ids.delete('parent'); await manager.deleteFor('parent');
		assert.deepEqual({ ownerDeleted: manager.get(checkpoint.id)?.ownerDeleted, parent: manager.list('parent').length, branches: manager.get(checkpoint.id)?.branchConversationIds }, { ownerDeleted: true, parent: 0, branches: ['first-branch', 'last-branch'] });
		const reopened = new CheckpointManager(conversations, state, host); t.after(() => reopened.dispose());
		await assert.rejects(reopened.restore(checkpoint.id, { conversationToo: true, conversationId: 'parent' }), /not associated/);
		// A palette restore without an explicit conversation must retain its recovery
		// point under a surviving branch, never under the deleted parent.
		await reopened.restore(checkpoint.id, { conversationToo: false });
		assert.equal(reopened.list('first-branch').length, 2);
		ids.delete('first-branch'); await reopened.deleteFor('first-branch');
		assert.equal(reopened.list('last-branch')[0]?.id, checkpoint.id);
		ids.delete('last-branch'); await reopened.deleteFor('last-branch');
		assert.deepEqual(reopened.listAll(), []);
		if (checkpoint.fileSnapshot) {
			const snapshot = checkpoint.fileSnapshot;
			await assert.rejects(fs.access(join(snapshot.storageRoot, createHash('sha256').update(snapshot.workspaceRoot).digest('hex'), snapshot.id)), { code: 'ENOENT' });
		} else { assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/son-of-anton/checkpoints/'), ''); }
	});
}

test('non-Git manager retains branch-linked checkpoints through parent deletion and count pruning', async t => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-checkpoint-manager-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'workspace'); await fs.mkdir(root); await fs.writeFile(join(root, 'file'), 'one');
	const values = new Map<string, unknown>(); const state: MementoStore = { get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T, update: async (key, value) => { values.set(key, value); } };
	const config: ConfigStore = { get: <T>(key: string, fallback?: T) => (key === 'checkpoints.maxCount' ? 1 : fallback) as T };
	const conversations = new Map([['parent', ['first', 'later']], ['branch', ['first', 'branch later']]]);
	const manager = new CheckpointManager({ load: id => { const messages = conversations.get(id); return messages ? { messages, summary: {} } : undefined; }, update: (id, messages) => { conversations.set(id, messages as string[]); } }, state, { storageRoot: join(directory, 'storage'), getWorkspaceRoot: () => root, config, confirmRestore: async () => true, notifier: { info() {}, warn(message) { assert.fail(message); }, error(message) { assert.fail(message); } } });
	t.after(() => manager.dispose());
	const checkpoint = await manager.capture('parent', 1, 'first'); assert.ok(checkpoint);
	await manager.attachToBranch(checkpoint.id, 'branch'); await manager.deleteFor('parent');
	await fs.writeFile(join(root, 'file'), 'two'); await manager.capture('other', 0, 'later'); await manager.capture('other', 1, 'latest');
	assert.equal(manager.list('branch')[0]?.id, checkpoint.id);
	await assert.rejects(manager.restore(checkpoint.id, { conversationToo: true, conversationId: 'unrelated' }), /not associated/);
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'two');
	await manager.restore(checkpoint.id, { conversationToo: true, conversationId: 'branch' });
	assert.deepEqual({ file: await fs.readFile(join(root, 'file'), 'utf8'), parent: conversations.get('parent'), branch: conversations.get('branch') }, { file: 'one', parent: ['first', 'later'], branch: ['first'] });
});

test('checkpoint capture and history use one index when Windows host path casing differs from native realpath', async t => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-checkpoint-casing-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'workspace'); await fs.mkdir(root); await fs.writeFile(join(root, 'file'), 'one');
	const canonicalRoot = await fs.realpath(root);
	const hostRoot = join(dirname(canonicalRoot), 'WORKSPACE');
	assert.notEqual(hostRoot, canonicalRoot);
	const nativeRealpath = syncFs.realpathSync.native, legacyRealpath = syncFs.realpathSync, asyncRealpath = fs.realpath;
	// Reproduce Windows resolution on every platform: the legacy JS resolver
	// preserves the input spelling; the native sync/async resolvers canonicalize it.
	t.mock.method(syncFs.realpathSync, 'native', (...args: Parameters<typeof nativeRealpath>) => nativeRealpath(args[0] === hostRoot ? canonicalRoot : args[0], args[1]));
	t.mock.method(syncFs, 'realpathSync', (...args: Parameters<typeof legacyRealpath>) => args[0] === hostRoot ? hostRoot : legacyRealpath(...args));
	t.mock.method(fs, 'realpath', (...args: Parameters<typeof asyncRealpath>) => asyncRealpath(args[0] === hostRoot ? canonicalRoot : args[0], args[1]));
	assert.equal(syncFs.realpathSync(hostRoot), hostRoot);
	assert.equal(syncFs.realpathSync.native(hostRoot), canonicalRoot);
	assert.equal(await fs.realpath(hostRoot), canonicalRoot);
	const values = new Map<string, unknown>(); const state: MementoStore = { get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T, update: async (key, value) => { values.set(key, value); } };
	const config: ConfigStore = { get: <T>(_key: string, fallback?: T) => fallback as T };
	let workspaceRoot = hostRoot;
	const host = { storageRoot: join(directory, 'storage'), getWorkspaceRoot: () => workspaceRoot, config, confirmRestore: async () => true, notifier: { info() {}, warn(message: string) { assert.fail(message); }, error(message: string) { assert.fail(message); } } };
	const conversations = { load: () => ({ messages: [], summary: {} }), update() {} };
	const manager = new CheckpointManager(conversations, state, host); t.after(() => manager.dispose());
	const checkpoint = await manager.capture('parent', 0, 'first'); assert.ok(checkpoint);
	assert.equal(checkpoint.fileSnapshot?.workspaceRoot, canonicalRoot);
	assert.equal(manager.get(checkpoint.id)?.id, checkpoint.id);
	await manager.attachToBranch(checkpoint.id, 'branch');
	assert.equal(manager.list('branch')[0]?.id, checkpoint.id);
	const indexFolders = await fs.readdir(join(directory, 'storage', 'index-v1'));
	assert.deepEqual(indexFolders, [createHash('sha256').update(canonicalRoot).digest('hex')]);
	assert.equal(values.size, 0, 'new checkpoints never write the per-window legacy index');
	// Opening the same workspace with either spelling retains the existing history.
	const reopened = new CheckpointManager(conversations, state, host); t.after(() => reopened.dispose());
	for (workspaceRoot of [canonicalRoot, hostRoot]) {
		assert.equal(reopened.get(checkpoint.id)?.id, checkpoint.id);
		assert.equal(reopened.listAll().length, 1);
	}
	await fs.writeFile(join(root, 'file'), 'two');
	await reopened.restore(checkpoint.id, { conversationToo: false, conversationId: 'branch' });
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'one');
	assert.equal(reopened.listAll().length, 2);
	assert.deepEqual(await fs.readdir(join(directory, 'storage', 'index-v1')), indexFolders);
	assert.equal(values.size, 0);
});


test('failed restore recovery indexing leaves files unchanged and repeated retries leave no orphan snapshots', async t => {
	const { manager, faults, root } = await captureFailureFixture(t);
	const original = await fs.readFile(join(root, 'file')); const target = await manager.capture('parent', 1, 'target'); assert.ok(target?.fileSnapshot);
	await fs.writeFile(join(root, 'file'), 'pre-restore contents'); await fs.writeFile(join(root, 'later'), 'precious new file');
	const failedRecoveries: FileSnapshot[] = [];
	faults.beforeWrite = async checkpoints => {
		const recovery = checkpoints.find(checkpoint => checkpoint.id !== target.id)!; assert.ok(recovery.fileSnapshot); failedRecoveries.push(recovery.fileSnapshot);
		assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'pre-restore contents');
		throw new Error('history disk full');
	};
	for (let attempt = 0; attempt < 3; attempt++) {
		await assert.rejects(manager.restore(target.id, { conversationToo: true }), /workspace files were not changed/);
		assert.equal(await fs.readFile(join(root, 'later'), 'utf8'), 'precious new file');
	}
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'pre-restore contents');
	for (const snapshot of failedRecoveries) { await assert.rejects(fs.access(snapshotDirectory(snapshot)), { code: 'ENOENT' }); }
	assert.deepEqual(await fs.readdir(dirname(snapshotDirectory(target.fileSnapshot))), [target.fileSnapshot.id]);
	assert.deepEqual(manager.listAll().map(checkpoint => checkpoint.id), [target.id]);
	faults.beforeWrite = undefined;
	await manager.restore(target.id, { conversationToo: false });
	assert.deepEqual(await fs.readFile(join(root, 'file')), original); await assert.rejects(fs.access(join(root, 'later')), { code: 'ENOENT' });
	const recovery = manager.list('parent').find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.fileSnapshot); assert.equal(manager.size(), 2);
	await manager.restore(recovery.id, { conversationToo: false });
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'pre-restore contents'); assert.equal(await fs.readFile(join(root, 'later'), 'utf8'), 'precious new file');
});

test('edits during recovery indexing abort restore and retain a visible recovery across manager restart', async t => {
	const { manager, faults, root, state, config, directory } = await captureFailureFixture(t);
	const target = await manager.capture('parent', 0, 'target'); assert.ok(target?.fileSnapshot); await fs.writeFile(join(root, 'file'), 'before restore');
	faults.beforeWrite = async checkpoints => { if (checkpoints.some(checkpoint => checkpoint.id !== target.id)) { await fs.writeFile(join(root, 'file'), 'edited during persistence'); } };
	await assert.rejects(manager.restore(target.id, { conversationToo: false }), /changed while confirming/);
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'edited during persistence');
	const recovery = manager.list('parent').find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.fileSnapshot); await fs.access(snapshotDirectory(recovery.fileSnapshot)); await fs.access(snapshotDirectory(target.fileSnapshot));
	faults.beforeWrite = undefined;
	const reopened = new CheckpointManager({ load: () => ({ messages: [], summary: {} }), update() {} }, state, { storageRoot: join(directory, 'storage'), getWorkspaceRoot: () => root, config, confirmRestore: async () => true, notifier: { info() {}, warn: message => assert.fail(message), error: message => assert.fail(message) } }); t.after(() => reopened.dispose());
	assert.equal(reopened.get(recovery.id)?.fileSnapshot?.id, recovery.fileSnapshot.id);
	await reopened.restore(recovery.id, { conversationToo: false }); assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'before restore');
});

test('post-commit restore pruning and notifier failures cannot discard indexed recovery', async t => {
	const { manager, faults, root, warnings } = await captureFailureFixture(t);
	const original = await fs.readFile(join(root, 'file')); const target = await manager.capture('parent', 0, 'target'); assert.ok(target?.fileSnapshot); await fs.writeFile(join(root, 'file'), 'retain me');
	let writes = 0; faults.beforeWrite = async () => { if (++writes === 2) { throw new Error('post-commit pruning failed'); } };
	faults.warn = () => { throw new Error('warning subscriber unavailable'); };
	await manager.restore(target.id, { conversationToo: false }); assert.deepEqual(await fs.readFile(join(root, 'file')), original);
	const recovery = manager.list('parent').find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.fileSnapshot); await fs.access(snapshotDirectory(recovery.fileSnapshot));
	assert.ok(warnings.some(message => message.includes('recovery checkpoint is saved')));
});

test('failed file application keeps pre-restore recovery indexed and files recoverable', async t => {
	const { manager, root } = await captureFailureFixture(t);
	const target = await manager.capture('parent', 0, 'target'); assert.ok(target?.fileSnapshot); await fs.writeFile(join(root, 'file'), 'pre-restore files');
	const rename = fs.rename; let rejected = false; const canonical = await fs.realpath(join(root, 'file'));
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { if (!rejected && String(args[1]) === canonical) { rejected = true; throw new Error('workspace temporarily unavailable'); } return rename(...args); });
	await assert.rejects(manager.restore(target.id, { conversationToo: false }), /previous files were recovered/);
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'pre-restore files');
	const recovery = manager.list('parent').find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.fileSnapshot); await fs.access(snapshotDirectory(recovery.fileSnapshot));
});


test('a concurrent capture and restore recovery both remain reachable at the count limit', async t => {
	const { manager, root } = await captureFailureFixture(t);
	const target = await manager.capture('parent', 0, 'target'); assert.ok(target?.fileSnapshot); await fs.writeFile(join(root, 'file'), 'pre-restore contents');
	const prototype = FileSnapshotStore.prototype as unknown as { apply(target: unknown, current: unknown): Promise<void> };
	const apply = prototype.apply; let entered!: () => void; let proceed!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { proceed = resolve; }); let calls = 0;
	t.mock.method(prototype, 'apply', async function (this: FileSnapshotStore, targetManifest: unknown, currentManifest: unknown) { if (++calls === 1) { entered(); await gate; } return apply.call(this, targetManifest, currentManifest); });
	const restoring = manager.restore(target.id, { conversationToo: false });
	let concurrent: Checkpoint | undefined;
	try {
		await started; await new Promise<void>(resolve => setTimeout(resolve, 2));
		concurrent = await manager.capture('other', 0, 'newer capture'); assert.ok(concurrent?.fileSnapshot);
		assert.ok(manager.get(concurrent.id)); await fs.access(snapshotDirectory(concurrent.fileSnapshot));
	} finally { proceed(); await restoring; }
	const recovery = manager.list('parent').find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.fileSnapshot); assert.ok(concurrent?.fileSnapshot);
	assert.ok(manager.get(concurrent.id)); await fs.access(snapshotDirectory(recovery.fileSnapshot)); await fs.access(snapshotDirectory(concurrent.fileSnapshot));
	assert.equal(manager.size(), 2, 'one ordinary checkpoint plus the just-used restore recovery');
});

test('failed unused-recovery cleanup keeps the index failure and identifies retained files', async t => {
	const { manager, root, faults } = await captureFailureFixture(t); const target = await manager.capture('parent', 0, 'target'); assert.ok(target?.fileSnapshot); await fs.writeFile(join(root, 'file'), 'unchanged');
	const indexError = new Error('original history failure'); const cleanupError = new Error('cleanup denied'); let recovery: FileSnapshot | undefined;
	faults.beforeWrite = async checkpoints => { recovery = checkpoints.find(checkpoint => checkpoint.id !== target.id)?.fileSnapshot; throw indexError; };
	t.mock.method(FileSnapshotStore.prototype, 'release', async () => { throw cleanupError; });
	await assert.rejects(manager.restore(target.id, { conversationToo: false }), error => {
		assert.ok(error instanceof AggregateError); assert.match(error.message, /workspace files were not changed/); assert.equal(syncFs.realpathSync.native(error.message.match(/removed from (.*)\.$/)![1]), snapshotDirectory(recovery!));
		assert.equal((error.errors[0] as Error).cause, indexError); assert.equal(error.errors[1], cleanupError); return true;
	});
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'unchanged'); assert.ok(recovery); await fs.access(snapshotDirectory(recovery)); assert.equal(manager.size(), 1);
});


test('failed Git restore indexing preserves staged and working files, HEAD and stash without orphan recovery refs', async t => {
	const { manager, faults, root } = await captureFailureFixture(t);
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'initial');
	await fs.writeFile(join(root, 'file'), 'stash contents'); git('stash', 'push', '-qm', 'existing user stash');
	const target = await manager.capture('parent', 0, 'target'); assert.ok(target?.snapshot);
	await fs.writeFile(join(root, 'file'), 'staged contents'); git('add', 'file'); await fs.writeFile(join(root, 'file'), 'unstaged contents'); await fs.writeFile(join(root, 'scratch'), 'untracked contents');
	const inspect = async () => ({ head: git('rev-parse', 'HEAD'), stash: git('stash', 'list'), index: git('write-tree'), status: git('status', '--porcelain'), file: await fs.readFile(join(root, 'file'), 'utf8'), scratch: await fs.readFile(join(root, 'scratch'), 'utf8') });
	const before = await inspect(); const refs = git('for-each-ref', '--format=%(refname)', 'refs/son-of-anton/checkpoints/'); let failures = 0;
	faults.beforeWrite = async checkpoints => { const recovery = checkpoints.find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.snapshot); assert.equal(git('rev-parse', recovery.snapshot.ref), recovery.snapshot.commit); failures++; throw new Error('Git recovery history unavailable'); };
	for (let attempt = 0; attempt < 2; attempt++) {
		await assert.rejects(manager.restore(target.id, { conversationToo: true }), /workspace files were not changed/);
		assert.deepEqual(await inspect(), before); assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/son-of-anton/checkpoints/'), refs);
	}
	assert.equal(failures, 2); faults.beforeWrite = undefined;
	await manager.restore(target.id, { conversationToo: false }); const recovery = manager.list('parent').find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.snapshot);
	assert.equal(git('rev-parse', 'HEAD'), before.head); assert.equal(git('stash', 'list'), before.stash); git('gc', '--prune=now');
	await manager.restore(recovery.id, { conversationToo: false }); assert.deepEqual(await inspect(), before);
});


test('failed Git capture index commits release only the new retained ref', async t => {
	const { manager, faults, root } = await captureFailureFixture(t);
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('add', '.'); git('commit', '-qm', 'initial');
	const retained = await manager.capture('original', 0, 'keep'); assert.ok(retained?.snapshot); const refs = git('for-each-ref', '--format=%(refname)', 'refs/son-of-anton/checkpoints/');
	faults.beforeWrite = async () => { throw new Error('index unavailable'); };
	for (let attempt = 0; attempt < 2; attempt++) { await assert.rejects(manager.capture('failed', 0, 'discard'), /index unavailable/); assert.equal(git('for-each-ref', '--format=%(refname)', 'refs/son-of-anton/checkpoints/'), refs); }
	assert.equal(manager.get(retained.id)?.snapshot?.ref, retained.snapshot.ref);
});
