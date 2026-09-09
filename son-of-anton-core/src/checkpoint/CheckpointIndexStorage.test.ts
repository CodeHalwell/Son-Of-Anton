/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { CheckpointIndexCommitUncertainError, CheckpointIndexStorage } from './CheckpointIndexStorage';
import { CheckpointManager, type Checkpoint } from './CheckpointManager';
import { FileSnapshotStore } from './FileSnapshotStore';
import { withCheckpointLock, readCheckpointMetadata } from './ProcessFileLock';

function checkpoint(id: string, conversationId = 'parent'): Checkpoint { return { id, conversationId, capturedAt: 1, turnIndex: 0, userMessage: 'legacy', kind: 'fs' }; }
async function fixture(t: TestContext) {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-shared-checkpoints-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = path.join(directory, 'workspace'); const storage = path.join(directory, 'storage'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'file'), 'original');
	const canonical = await fs.realpath(root); const indexDirectory = path.join(storage, 'index-v1', createHash('sha256').update(canonical).digest('hex'));
	const issues: string[] = [];
	const index = (legacy: readonly Checkpoint[] = []) => new CheckpointIndexStorage(storage, canonical, () => legacy, message => { issues.push(message); });
	const manager = (max = 100, legacy: Checkpoint[] = []) => {
		const value = new CheckpointManager({ load: () => ({ messages: [], summary: {} }), update() {} }, { get: <T>() => legacy as T, update: async () => { assert.fail('Legacy Memento must remain read-only'); } }, { storageRoot: storage, getWorkspaceRoot: () => root, config: { get: <T>(key: string, fallback?: T) => (key === 'checkpoints.maxCount' ? max : fallback) as T }, confirmRestore: async () => true, notifier: { info() {}, warn(message) { issues.push(message); }, error(message) { assert.fail(message); } } });
		t.after(() => value.dispose()); return value;
	};
	return { directory, root, storage, canonical, indexDirectory, file: path.join(indexDirectory, 'index.json'), index, manager, issues };
}
function child(options: object) {
	const running = spawn(process.execPath, [path.join(__dirname, 'fixtures', 'CheckpointProcess.js'), JSON.stringify(options)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 30_000, killSignal: 'SIGKILL' });
	let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; }); let result: Checkpoint | undefined; let errors = '';
	running.on('message', value => { const message = value as { stage: string; checkpoint?: Checkpoint }; if (message.stage === 'ready') { ready(); } if (message.checkpoint) { result = message.checkpoint; } });
	running.stderr!.on('data', data => { errors += String(data); });
	const done = new Promise<void>((resolve, reject) => { running.once('error', reject); running.once('exit', code => { if (code === 0) { resolve(); } else { reject(new Error(`Checkpoint child failed (${code}): ${errors}`)); } }); });
	void done.catch(() => {});
	return { running, ready: Promise.race([started, done.then(() => { throw new Error('Child exited before its barrier'); })]), done, result: () => result };
}
function snapshotPath(checkpoint: Checkpoint): string { const snapshot = checkpoint.fileSnapshot!; return path.join(snapshot.storageRoot, createHash('sha256').update(snapshot.workspaceRoot).digest('hex'), snapshot.id); }

test('two actual processes starting from empty cached indexes retain both captures after restart', async t => {
	const f = await fixture(t); const left = child({ root: f.root, storage: f.storage, mode: 'capture', conversationId: 'left' }); const right = child({ root: f.root, storage: f.storage, mode: 'capture', conversationId: 'right' });
	try { await Promise.all([left.ready, right.ready]); left.running.send('go'); right.running.send('go'); await Promise.all([left.done, right.done]); }
	finally { if (left.running.connected) { left.running.send('go'); } if (right.running.connected) { right.running.send('go'); } await Promise.all([left.done, right.done]); }
	const first = left.result(); const second = right.result(); assert.ok(first?.fileSnapshot); assert.ok(second?.fileSnapshot);
	assert.deepEqual(f.manager().listAll().map(item => item.id).sort(), [first.id, second.id].sort()); await fs.access(snapshotPath(first)); await fs.access(snapshotPath(second));
	const persisted = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.deepEqual(persisted.importedLegacyIds, []); assert.deepEqual(persisted.deletedConversationIds, []);
});

test('independent managers preserve concurrent capture and branch updates and delete the final owner', async t => {
	const f = await fixture(t); const first = f.manager(); const second = f.manager(); const original = await first.capture('parent', 0, 'original'); assert.ok(original?.fileSnapshot);
	second.listAll(); const [, other] = await Promise.all([second.attachToBranch(original.id, 'branch'), first.capture('other', 0, 'concurrent')]); assert.ok(other);
	assert.deepEqual(f.manager().get(original.id)?.branchConversationIds, ['branch']); assert.ok(second.get(other.id));
	await first.deleteFor('parent'); assert.equal(second.list('branch')[0]?.id, original.id); await fs.access(snapshotPath(original));
	await second.deleteFor('branch'); assert.equal(first.get(original.id), undefined); await assert.rejects(fs.access(snapshotPath(original)), { code: 'ENOENT' }); assert.ok(first.get(other.id));
});

test('legacy import stays read-only, cannot resurrect removed IDs and ignores already-imported stale corruption', async t => {
	const f = await fixture(t); const legacy = [checkpoint('legacy')]; const first = f.index(legacy); await first.mutate(index => index);
	assert.equal(legacy.length, 1); legacy[0] = { ...legacy[0], kind: 'invalid' as 'fs' }; assert.equal(first.read()[0].id, 'legacy');
	await f.index().mutate(() => []); assert.deepEqual(first.read(), []); await first.mutate(index => index); assert.deepEqual(f.index().read(), []);
	assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')).importedLegacyIds, ['legacy']);
});

test('deletion blocks unseen late legacy owners and branches from a different window', async t => {
	const f = await fixture(t); const empty = f.index(); await empty.mutate(index => index, undefined, 'parent');
	const late = f.index([{ ...checkpoint('late'), branchConversationIds: ['survivor', 'deleted-branch'] }]); await empty.mutate(index => index, undefined, 'deleted-branch');
	assert.deepEqual(late.read().map(item => ({ ownerDeleted: item.ownerDeleted, branches: item.branchConversationIds })), [{ ownerDeleted: true, branches: ['survivor'] }]);
	await late.mutate(index => index); await empty.mutate(() => [], undefined, 'survivor'); assert.deepEqual(late.read(), []);
	await assert.rejects(empty.mutate(index => [...index, checkpoint('new', 'parent')]), /permanently deleted/);
});

test('damaged durable metadata fails closed without replacing it from legacy', async t => {
	const f = await fixture(t); const index = f.index([checkpoint('legacy')]); await index.mutate(items => items); await fs.writeFile(f.file, '{damaged');
	assert.throws(() => index.read(), /preserved for recovery/); await assert.rejects(index.mutate(items => items), /preserved for recovery/);
	assert.equal(await fs.readFile(f.file, 'utf8'), '{damaged'); assert.ok(f.issues.length);
});

test('a crashed process pin protects active restore snapshots then becomes reclaimable', async t => {
	const f = await fixture(t); const manager = f.manager(1); const original = await manager.capture('parent', 0, 'original'); assert.ok(original?.fileSnapshot);
	const pin = child({ root: f.root, storage: f.storage, mode: 'pin', checkpointId: original.id, crash: true });
	try {
		await pin.ready; const newer = await manager.capture('other', 0, 'newer'); assert.ok(newer); assert.ok(manager.get(original.id));
		await assert.rejects(manager.deleteFor('parent'), /restore in progress/); pin.running.send('go'); await pin.done;
	} finally { if (pin.running.connected) { pin.running.send('go'); } await pin.done; }
	await manager.capture('latest', 0, 'after restart'); assert.equal(manager.get(original.id), undefined); await assert.rejects(fs.access(snapshotPath(original)), { code: 'ENOENT' });
	assert.equal((await fs.readdir(f.indexDirectory)).filter(name => name.startsWith('.pin-')).length, 0);
});

test('non-Git restore locks serialize confirmation and apply across actual processes', async t => {
	const f = await fixture(t); const store = new FileSnapshotStore(f.root, f.storage); const target = await store.capture(); await fs.writeFile(path.join(f.root, 'file'), 'before restore');
	const restoring = child({ root: f.root, storage: f.storage, mode: 'restore', snapshot: target }); let secondConfirmed = false; let second: Promise<unknown> | undefined;
	try {
		await restoring.ready; second = store.restore(target, async () => { secondConfirmed = true; assert.equal(await fs.readFile(path.join(f.root, 'file'), 'utf8'), 'original'); return false; });
		await new Promise<void>(resolve => setTimeout(resolve, 30)); assert.equal(secondConfirmed, false);
		restoring.running.send('go'); await restoring.done; await second; assert.equal(secondConfirmed, true);
	} finally { if (restoring.running.connected) { restoring.running.send('go'); } await restoring.done; await second; }
});

test('a dead process lock is reclaimed without blocking subsequent operations', async t => {
	const f = await fixture(t); const locked = child({ root: f.root, storage: f.storage, mode: 'lock', crash: true });
	await locked.ready; locked.running.send('go'); await locked.done; let entered = false;
	await withCheckpointLock(path.join(f.storage, 'lock-test'), async () => { entered = true; }); assert.equal(entered, true);
	assert.deepEqual(await fs.readdir(path.join(f.storage, 'lock-test')), []);
});

test('invalid API identifiers and oversized metadata cannot poison a healthy index', async t => {
	const f = await fixture(t); const index = f.index(); await index.mutate(() => [checkpoint('valid')]); const before = await fs.readFile(f.file, 'utf8');
	await assert.rejects(index.mutate(items => items, undefined, 'x'.repeat(513)), /Invalid conversation/);
	const pin = await index.pin('valid'); try { await assert.rejects(pin.add('x'.repeat(513)), /Invalid checkpoint/); } finally { await pin.release(); }
	const invalid = path.join(f.indexDirectory, `.pin-${process.pid}-${randomUUID()}`); await fs.writeFile(invalid, Buffer.alloc(1024 * 1024 + 1));
	await assert.rejects(index.mutate(items => items), /oversized/); assert.equal(await fs.readFile(f.file, 'utf8'), before);
	await fs.rm(invalid); assert.equal(index.read()[0].id, 'valid');
	await fs.writeFile(invalid, 'x'.repeat(33)); assert.throws(() => readCheckpointMetadata(invalid, 32), /oversized/);
});

test('failed choosing publication and post-operation cleanup do not strand a live lock', async t => {
	const f = await fixture(t); const directory = path.join(f.storage, 'lock-test'); const remove = syncFs.rmSync; let failed = false;
	t.mock.method(syncFs, 'rmSync', (...args: Parameters<typeof remove>) => { if (!failed && String(args[0]).endsWith('.tmp')) { failed = true; throw new Error('choosing cleanup failed'); } return remove(...args); });
	await assert.rejects(withCheckpointLock(directory, async () => assert.fail('must not enter')), /choosing cleanup failed/);
	assert.equal((await fs.readdir(directory)).some(name => name.startsWith('.lock-') && !name.endsWith('.tmp')), false);
	const rm = fs.rm; let completed = false; let denied = false; const issues: string[] = [];
	t.mock.method(fs, 'rm', async (...args: Parameters<typeof rm>) => { if (completed && !denied && path.basename(String(args[0])).startsWith('.lock-') && !String(args[0]).endsWith('.tmp')) { denied = true; throw new Error('lock cleanup denied'); } return rm(...args); });
	await withCheckpointLock(directory, async () => { completed = true; }, message => issues.push(message)); assert.equal(issues.length, 1);
	await withCheckpointLock(directory, async () => {}); assert.equal((await fs.readdir(directory)).filter(name => name.startsWith('.lock-') && !name.endsWith('.tmp')).length, 0);
});


test('post-commit temporary cleanup cannot invalidate a saved index', async t => {
	const f = await fixture(t); const index = f.index(); const rename = fs.rename; const rm = fs.rm; let committed = false; let failed = false; let marked = false;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { await rename(...args); if (String(args[1]) === f.file) { committed = true; } });
	t.mock.method(fs, 'rm', async (...args: Parameters<typeof rm>) => { if (committed && !failed && String(args[0]).endsWith('.tmp')) { failed = true; throw new Error('temporary cleanup denied'); } return rm(...args); });
	await index.mutate(() => [checkpoint('committed')], () => { marked = true; }); assert.equal(marked, true); assert.equal(index.read()[0].id, 'committed'); assert.ok(f.issues.some(message => message.includes('saved')));
});

test('a failed pin acquisition cleans its published file rather than orphaning a live pin', async t => {
	const f = await fixture(t); const index = f.index(); await index.mutate(() => [checkpoint('target')]); const rename = fs.rename;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { await rename(...args); if (path.basename(String(args[1])).startsWith('.pin-')) { throw new Error('post-pin rename failed'); } });
	await assert.rejects(index.pin('target'), /post-pin rename failed/); assert.equal((await fs.readdir(f.indexDirectory)).some(name => name.startsWith('.pin-')), false);
	await index.mutate(() => []); assert.deepEqual(index.read(), []);
});

test('post-restore pin cleanup failure preserves completion and requested conversation rewind', async t => {
	const f = await fixture(t); const manager = f.manager(); const target = await manager.capture('parent', 0, 'target'); assert.ok(target); await fs.writeFile(path.join(f.root, 'file'), 'later');
	const internal = manager as unknown as { indexStore(): CheckpointIndexStorage; conversationStore: { update(): void } }; let rewound = false; t.mock.method(internal.conversationStore, 'update', () => { rewound = true; });
	const index = internal.indexStore(); const pin = index.pin.bind(index);
	t.mock.method(index, 'pin', async (...args: Parameters<typeof pin>) => { const owned = await pin(...args); return { ...owned, remove: async () => { throw new Error('pin cleanup denied'); } }; });
	await manager.restore(target.id, { conversationToo: true }); assert.equal(rewound, true); assert.equal(await fs.readFile(path.join(f.root, 'file'), 'utf8'), 'original'); assert.ok(f.issues.some(message => message.includes('pin cleanup denied')));
});

test('an ambiguous committed index remains preserved when verification is temporarily unreadable', async t => {
	const f = await fixture(t); const manager = f.manager(); const rename = fs.rename; const open = syncFs.openSync; let unreadable = false;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { await rename(...args); if (String(args[1]) === f.file) { unreadable = true; throw new Error('rename completion unavailable'); } });
	t.mock.method(syncFs, 'openSync', (...args: Parameters<typeof open>) => { if (unreadable && String(args[0]) === f.file) { throw Object.assign(new Error('verification unavailable'), { code: 'EACCES' }); } return open(...args); });
	await assert.rejects(manager.capture('parent', 0, 'uncertain'), CheckpointIndexCommitUncertainError); unreadable = false;
	const retained = manager.listAll()[0]; assert.ok(retained?.fileSnapshot); await fs.access(snapshotPath(retained));
});

test('an uncertain recovery-index commit cancels restore without changing files or discarding recovery', async t => {
	const f = await fixture(t); const manager = f.manager(); const target = await manager.capture('parent', 0, 'target'); assert.ok(target?.fileSnapshot);
	await fs.writeFile(path.join(f.root, 'file'), 'pre-restore contents'); let rewound = false;
	const conversation = (manager as unknown as { conversationStore: { update(): void } }).conversationStore; t.mock.method(conversation, 'update', () => { rewound = true; });
	const rename = fs.rename; const open = syncFs.openSync; let unreadable = false;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { await rename(...args); if (String(args[1]) === f.file) { unreadable = true; throw new Error('recovery rename completion unavailable'); } });
	t.mock.method(syncFs, 'openSync', (...args: Parameters<typeof open>) => { if (unreadable && String(args[0]) === f.file) { throw Object.assign(new Error('verification unavailable'), { code: 'EACCES' }); } return open(...args); });
	await assert.rejects(manager.restore(target.id, { conversationToo: true }), error => { assert.ok(error instanceof Error); assert.match(error.message, /workspace files were not changed/); assert.ok(error.cause instanceof CheckpointIndexCommitUncertainError); return true; });
	assert.equal(await fs.readFile(path.join(f.root, 'file'), 'utf8'), 'pre-restore contents'); assert.equal(rewound, false); unreadable = false;
	const recovery = manager.listAll().find(checkpoint => checkpoint.id !== target.id); assert.ok(recovery?.fileSnapshot); await fs.access(snapshotPath(target)); await fs.access(snapshotPath(recovery));
});
