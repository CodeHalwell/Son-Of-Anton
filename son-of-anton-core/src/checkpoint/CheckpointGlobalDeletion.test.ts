/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CheckpointManager, type Checkpoint } from './CheckpointManager';
import { CheckpointIndexStorage } from './CheckpointIndexStorage';
import { FileSnapshotStore } from './FileSnapshotStore';
import { GitSnapshotStore } from './GitSnapshotStore';

const hash = (root: string) => createHash('sha256').update(root).digest('hex');
const key = (root: string) => `sota.checkpoints.index.${hash(root)}`;
const payload = (checkpoint: Checkpoint) => path.join(checkpoint.fileSnapshot!.storageRoot, hash(checkpoint.fileSnapshot!.workspaceRoot), checkpoint.fileSnapshot!.id);
async function fixture(t: TestContext) {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-global-checkpoint-delete-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const a = path.join(directory, 'a'); const b = path.join(directory, 'b'); const storage = path.join(directory, 'storage');
	for (const root of [a, b]) { await fs.mkdir(root); await fs.writeFile(path.join(root, 'file'), 'original'); }
	const legacy = new Map<string, Checkpoint[]>(); const issues: string[] = [];
	const manager = (root?: string) => {
		const value = new CheckpointManager({ load: () => ({ messages: [], summary: {} }), update() {} }, { keys: () => [...legacy.keys()], get: <T>(key: string) => legacy.get(key) as T, update: async () => assert.fail('Legacy state is read-only') }, {
			storageRoot: storage, getWorkspaceRoot: () => root, config: { get: <T>(_key: string, fallback?: T) => fallback as T }, confirmRestore: async () => true,
			notifier: { info() {}, warn: message => { issues.push(message); }, error: message => assert.fail(message) },
		}); t.after(() => value.dispose()); return value;
	};
	return { directory, a, b, storage, legacy, issues, manager, index: (root: string) => path.join(storage, 'index-v1', hash(root), 'index.json') };
}
function child(options: object) {
	const running = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'CheckpointProcess.js'), JSON.stringify(options)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 30_000, killSignal: 'SIGKILL' });
	let ready!: () => void; const staged = new Promise<void>(resolve => { ready = resolve; }); let errors = '';
	running.on('message', value => { if ((value as { stage: string }).stage === 'ready') { ready(); } }); running.stderr!.on('data', data => { errors += String(data); });
	const done = new Promise<void>((resolve, reject) => { running.once('error', reject); running.once('exit', code => code === 0 ? resolve() : reject(new Error(`Checkpoint child failed (${code}): ${errors}`))); });
	const started = Promise.race([staged, done.then(() => { throw new Error('Child exited before its barrier'); })]); void started.catch(() => {}); void done.catch(() => {});
	return { running, ready: started, done };
}

test('permanent deletion from B and no-workspace cleans A and B while preserving explicit branches', async t => {
	const f = await fixture(t); const a = f.manager(f.a); const b = f.manager(f.b);
	const first = await a.capture('parent', 0, 'a'); const second = await b.capture('parent', 0, 'b'); const other = await a.capture('other', 0, 'unrelated'); assert.ok(first && second && other);
	await a.attachToBranch(first.id, 'branch'); await b.deleteFor('parent');
	assert.deepEqual(a.list('parent'), []); assert.equal(a.list('branch')[0]?.id, first.id); await fs.access(payload(first)); await assert.rejects(fs.access(payload(second)), { code: 'ENOENT' });
	await f.manager().deleteFor('branch'); assert.deepEqual(f.manager(f.a).list('branch'), []); await assert.rejects(fs.access(payload(first)), { code: 'ENOENT' }); await fs.access(payload(other));
	await assert.rejects(f.manager(f.b).capture('branch', 0, 'retired'), /permanently deleted/);
});

test('never-imported legacy snapshots are discovered and cleaned without reopening a removed workspace', async t => {
	const f = await fixture(t); const canonical = await fs.realpath(f.a); const snapshot = await new FileSnapshotStore(f.a, f.storage).capture();
	const checkpoint: Checkpoint = { id: 'legacy', conversationId: 'parent', kind: 'fs', fileSnapshot: snapshot, turnIndex: 0, capturedAt: 1, userMessage: 'legacy' };
	f.legacy.set(key(canonical), [checkpoint]); await fs.rm(f.a, { recursive: true });
	await f.manager().deleteFor('parent'); await assert.rejects(fs.access(payload(checkpoint)), { code: 'ENOENT' });
	const index = new CheckpointIndexStorage(f.storage, canonical, () => [checkpoint], () => {}); assert.deepEqual(index.read(), []); await index.mutate(items => items); assert.deepEqual(index.read(), []); assert.equal(f.legacy.get(key(canonical))?.length, 1);
});

test('cleanup descriptors survive a release failure and a restart before retry', async t => {
	const f = await fixture(t); const checkpoint = await f.manager(f.a).capture('parent', 0, 'a'); assert.ok(checkpoint);
	const release = FileSnapshotStore.prototype.release; let fail = true;
	t.mock.method(FileSnapshotStore.prototype, 'release', async function (this: FileSnapshotStore, snapshot: Parameters<typeof release>[0]) { if (fail && snapshot.id === checkpoint.fileSnapshot!.id) { throw new Error('release denied'); } return release.call(this, snapshot); });
	await assert.rejects(f.manager(f.b).deleteFor('parent'), /cleanup is incomplete/); assert.deepEqual(f.manager(f.a).list('parent'), []); await fs.access(payload(checkpoint));
	const file = f.index(checkpoint.fileSnapshot!.workspaceRoot); assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pendingCleanup[0].id, checkpoint.id);
	fail = false; await f.manager().deleteFor('parent'); await assert.rejects(fs.access(payload(checkpoint)), { code: 'ENOENT' }); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).pendingCleanup, []);
});

test('deletion remains hidden after index-write failure and completes on retry', async t => {
	const f = await fixture(t); const checkpoint = await f.manager(f.a).capture('parent', 0, 'a'); assert.ok(checkpoint);
	const rename = fs.rename; const index = f.index(checkpoint.fileSnapshot!.workspaceRoot); let fail = true;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { if (fail && String(args[1]) === index) { throw new Error('index write denied'); } return rename(...args); });
	await assert.rejects(f.manager(f.b).deleteFor('parent'), /index write denied/); assert.deepEqual(f.manager(f.a).list('parent'), []); await fs.access(payload(checkpoint));
	fail = false; await f.manager().deleteFor('parent'); await assert.rejects(fs.access(payload(checkpoint)), { code: 'ENOENT' });
});

test('a failed global deletion commit leaves the original checkpoint readable', async t => {
	const f = await fixture(t); const checkpoint = await f.manager(f.a).capture('parent', 0, 'a'); assert.ok(checkpoint); const rename = fs.rename;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { if (path.basename(String(args[1])) === 'deleted.json') { throw new Error('journal denied'); } return rename(...args); });
	await assert.rejects(f.manager(f.b).deleteFor('parent'), /journal denied/); assert.equal(f.manager(f.a).get(checkpoint.id)?.id, checkpoint.id); await fs.access(payload(checkpoint));
});

test('a separate process cannot publish its first workspace index after global deletion', async t => {
	const f = await fixture(t); const writer = child({ root: f.a, storage: f.storage, mode: 'capture', conversationId: 'parent', expectDeleted: true });
	try { await writer.ready; await f.manager(f.b).deleteFor('parent'); writer.running.send('go'); await writer.done; }
	finally { if (writer.running.connected) { writer.running.send('go'); } await writer.done; }
	assert.deepEqual(f.manager(f.a).list('parent'), []); assert.deepEqual(await fs.readdir(path.join(f.storage, hash(await fs.realpath(f.a)))), []);
});

test('global deletion waits for another process index writer and retries an active restore pin', async t => {
	const f = await fixture(t); const checkpoint = await f.manager(f.a).capture('parent', 0, 'a'); assert.ok(checkpoint);
	const locked = child({ root: f.a, storage: f.storage, mode: 'index-lock' }); let deletion: Promise<void> | undefined; let completed = false;
	try { await locked.ready; deletion = f.manager(f.b).deleteFor('parent').then(() => { completed = true; }); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(completed, false); locked.running.send('go'); await locked.done; await deletion; }
	finally { if (locked.running.connected) { locked.running.send('go'); } await locked.done; await deletion; }
	await assert.rejects(fs.access(payload(checkpoint)), { code: 'ENOENT' });
	const target = await f.manager(f.a).capture('pinned', 0, 'pin'); assert.ok(target); const pin = child({ root: f.a, storage: f.storage, mode: 'pin', checkpointId: target.id });
	try { await pin.ready; await assert.rejects(f.manager().deleteFor('pinned'), /restore in progress/); await fs.access(payload(target)); assert.deepEqual(f.manager(f.a).list('pinned'), []); }
	finally { if (pin.running.connected) { pin.running.send('go'); } await pin.done; }
	await f.manager().deleteFor('pinned'); await assert.rejects(fs.access(payload(target)), { code: 'ENOENT' });
});

test('temporary branch detachment preserves owned checkpoints and permits future captures', async t => {
	const f = await fixture(t); const a = f.manager(f.a); const first = await a.capture('parent', 0, 'a'); const owned = await a.capture('branch', 0, 'owned'); assert.ok(first && owned);
	await a.attachToBranch(first.id, 'branch'); await f.manager().detachBranch('branch'); assert.equal(a.get(owned.id)?.id, owned.id); assert.deepEqual(a.get(first.id)?.branchConversationIds, []);
	assert.ok(await f.manager(f.b).capture('branch', 0, 'recovered'));
});

test('damaged cleanup overlap is rejected without releasing an active payload', async t => {
	const f = await fixture(t); const checkpoint = await f.manager(f.a).capture('parent', 0, 'a'); assert.ok(checkpoint);
	const file = f.index(checkpoint.fileSnapshot!.workspaceRoot); const index = JSON.parse(await fs.readFile(file, 'utf8')); index.pendingCleanup = [checkpoint]; await fs.writeFile(file, JSON.stringify(index));
	await assert.rejects(f.manager().deleteFor('parent'), /preserved for recovery/); await fs.access(payload(checkpoint));
});

test('Git refs in another workspace survive failed cleanup and are removed on a later retry', async t => {
	const f = await fixture(t); const git = (args: string[]) => promisify(execFile)('git', ['-C', f.a, ...args]);
	await git(['init']); await git(['add', '.']); await git(['-c', 'user.name=Checkpoint Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'initial']);
	const checkpoint = await f.manager(f.a).capture('parent', 0, 'git'); assert.ok(checkpoint?.snapshot);
	const release = GitSnapshotStore.prototype.release; let fail = true;
	t.mock.method(GitSnapshotStore.prototype, 'release', async function (this: GitSnapshotStore, snapshot: Parameters<typeof release>[0]) { if (fail) { throw new Error('Git ref busy'); } return release.call(this, snapshot); });
	await assert.rejects(f.manager(f.b).deleteFor('parent'), /cleanup is incomplete/); await git(['show-ref', '--verify', checkpoint.snapshot.ref]);
	fail = false; await f.manager().deleteFor('parent'); await assert.rejects(git(['show-ref', '--verify', checkpoint.snapshot.ref]));
});

test('global deletion uses the healthy durable copy when already-imported legacy metadata is stale', async t => {
	const f = await fixture(t); const canonical = await fs.realpath(f.a); const snapshot = await new FileSnapshotStore(f.a, f.storage).capture();
	const checkpoint: Checkpoint = { id: 'legacy', conversationId: 'parent', kind: 'fs', fileSnapshot: snapshot, turnIndex: 0, capturedAt: 1, userMessage: 'legacy' };
	f.legacy.set(key(canonical), [checkpoint]); const index = new CheckpointIndexStorage(f.storage, canonical, () => f.legacy.get(key(canonical))!, () => {}); await index.mutate(items => items);
	f.legacy.set(key(canonical), [{ ...checkpoint, fileSnapshot: { ...snapshot, workspaceRoot: 'damaged stale identity' } }]);
	await f.manager().deleteFor('parent'); assert.deepEqual(index.read(), []); await assert.rejects(fs.access(payload(checkpoint)), { code: 'ENOENT' });
});

test('an unreadable global journal fails closed and preserves existing snapshot metadata', async t => {
	const f = await fixture(t); const checkpoint = await f.manager(f.a).capture('parent', 0, 'a'); assert.ok(checkpoint);
	const file = f.index(checkpoint.fileSnapshot!.workspaceRoot); const before = await fs.readFile(file, 'utf8');
	await fs.writeFile(path.join(f.storage, 'index-v1', '.lifecycle', 'deleted.json'), '{damaged');
	assert.throws(() => f.manager(f.a).list('parent'), /preserved for recovery/); await assert.rejects(f.manager().deleteFor('parent'));
	assert.equal(await fs.readFile(file, 'utf8'), before); await fs.access(payload(checkpoint));
});
