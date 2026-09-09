/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { CheckpointManager } from 'son-of-anton-core/checkpoint/CheckpointManager';
import { ConversationActions } from '../src/chat/ConversationActions';
import { ConversationStore } from '../src/chat/ConversationStore';
import { ConversationStorage } from '../src/chat/ConversationStorage';

class Memento implements vscode.Memento {
	private readonly values = new Map<string, unknown>();
	keys(): string[] { return [...this.values.keys()]; }
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	async update(key: string, value: unknown): Promise<void> { if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); } }
}

async function fixture(run: (value: {
	store: ConversationStore; disk: ConversationStorage; manager: CheckpointManager; actions: ConversationActions;
	sourceId: string; checkpointId: string; snapshotPath: string; retained: string[]; dropped: string[];
	setRetainFailure(error?: Error): void;
}) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-branch-failure-'));
	const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'file.txt'), 'original workspace');
	const state = new Memento();
	const context = { globalState: state, workspaceState: new Memento(), globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')) } as unknown as vscode.ExtensionContext;
	const store = new ConversationStore(context);
	const manager = new CheckpointManager(store, state, {
		storageRoot: path.join(directory, 'snapshots'), getWorkspaceRoot: () => workspace,
		config: { get: <T>(key: string, fallback?: T) => (key === 'checkpoints.maxCount' ? 1 : fallback) as T },
		confirmRestore: async () => true, notifier: { info() {}, warn(message) { assert.fail(message); }, error(message) { assert.fail(message); } },
	});
	try {
		await store.ready;
		const source = store.create([{ role: 'user', content: 'Question', timestamp: 1 }, { role: 'assistant', content: 'Answer', timestamp: 2 }]); await store.flush();
		const checkpoint = await manager.capture(source.summary.id, 2, 'Before branching'); assert.ok(checkpoint?.fileSnapshot);
		const snapshot = checkpoint.fileSnapshot;
		const retained: string[] = []; const dropped: string[] = []; let retainFailure: Error | undefined;
		const actions = new ConversationActions(store, (_id, count) => count === 2 ? checkpoint.id : undefined,
			async (id, branchId) => { retained.push(branchId); await manager.attachToBranch(id, branchId); if (retainFailure) { throw retainFailure; } },
			async branchId => { dropped.push(branchId); await manager.detachBranch(branchId); });
		await run({ store, disk: (store as unknown as { disk: ConversationStorage }).disk, manager, actions, sourceId: source.summary.id, checkpointId: checkpoint.id,
			snapshotPath: path.join(snapshot.storageRoot, createHash('sha256').update(snapshot.workspaceRoot).digest('hex'), snapshot.id), retained, dropped, setRetainFailure: error => { retainFailure = error; } });
	} finally { manager.dispose(); store.dispose(); await store.flush().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); }
}

suite('Conversation branch failure recovery', () => {
	test('full storage drops only the failed branch attachment and retry preserves an explicitly unlinked transcript', async () => {
		await fixture(async f => {
			const surviving = await f.actions.branch(f.sourceId, 1); assert.ok(surviving);
			const originalSave = f.disk.save.bind(f.disk); const storageFailure = new Error('ENOSPC: conversation volume is full'); let full = true;
			f.disk.save = async (...args) => { if (full && args[0].summary.branch && args[0].summary.id !== surviving.summary.id) { throw storageFailure; } await originalSave(...args); };
			await assert.rejects(f.actions.branch(f.sourceId, 1), error => error instanceof AggregateError && error.errors[0] === storageFailure);
			const failedId = f.retained.at(-1)!;
			assert.deepEqual(f.dropped, [failedId]);
			assert.equal(f.disk.load(failedId), undefined);
			assert.deepEqual(f.store.load(failedId)?.summary.branch, { parentId: f.sourceId, throughMessageIndex: 1, checkpointId: undefined, workspaceState: 'unlinked' });
			assert.deepEqual(f.manager.get(f.checkpointId)?.branchConversationIds, [surviving.summary.id]);
			assert.deepEqual(f.store.load(f.sourceId)?.messages.map(message => message.content), ['Question', 'Answer']);
			await fs.access(f.snapshotPath);
			full = false; f.store.rename(failedId, 'Recovered branch'); await f.store.flush();
			assert.equal(f.disk.load(failedId)?.summary.branch?.workspaceState, 'unlinked');
			assert.equal(f.disk.load(failedId)?.summary.branch?.checkpointId, undefined);
			const retry = await f.actions.branch(f.sourceId, 1); assert.ok(retry);
			assert.notEqual(retry.summary.id, failedId);
			assert.deepEqual(f.manager.get(f.checkpointId)?.branchConversationIds, [surviving.summary.id, retry.summary.id]);
			await f.manager.deleteFor(f.sourceId); await f.manager.deleteFor(surviving.summary.id);
			await fs.access(f.snapshotPath); assert.equal(f.manager.list(retry.summary.id)[0]?.id, f.checkpointId);
			await f.manager.deleteFor(retry.summary.id);
			assert.equal(f.manager.get(f.checkpointId), undefined);
			await assert.rejects(fs.access(f.snapshotPath), { code: 'ENOENT' });
			const continued = await f.manager.capture(failedId, 2, 'Continue recovered branch'); assert.ok(continued?.fileSnapshot);
			assert.equal(f.manager.list(failedId)[0]?.id, continued.id, 'rollback removes the old link without permanently deleting the recovered conversation');
			assert.equal(f.disk.load(failedId)?.summary.branch?.workspaceState, 'unlinked');
		});
	});

	test('a retain failure after attachment rolls back ownership and leaves a durable unlinked branch before retry', async () => {
		await fixture(async f => {
			const retainFailure = new Error('Retention confirmation failed'); f.setRetainFailure(retainFailure);
			await assert.rejects(f.actions.branch(f.sourceId, 1), error => error === retainFailure);
			const failedId = f.retained[0];
			assert.deepEqual(f.dropped, [failedId]);
			assert.equal(f.manager.list(failedId).length, 0);
			assert.equal(f.manager.list(f.sourceId)[0]?.id, f.checkpointId);
			assert.equal(f.disk.load(failedId)?.summary.branch?.workspaceState, 'unlinked');
			await fs.access(f.snapshotPath);
			f.setRetainFailure(); const retry = await f.actions.branch(f.sourceId, 1); assert.ok(retry);
			assert.deepEqual(f.manager.get(f.checkpointId)?.branchConversationIds, [retry.summary.id]);
		});
	});

	test('metadata recovery failure cannot prevent checkpoint detachment and preserves both causes', async () => {
		await fixture(async f => {
			const retainFailure = new Error('Retain failed after commit'); const unlinkFailure = new Error('Pending metadata unavailable');
			f.setRetainFailure(retainFailure);
			f.store.unlinkBranchCheckpoint = () => { throw unlinkFailure; };
			await assert.rejects(f.actions.branch(f.sourceId, 1), error => error instanceof AggregateError && error.errors[0] === retainFailure && error.errors.includes(unlinkFailure));
			assert.deepEqual(f.dropped, f.retained);
			assert.equal(f.manager.get(f.checkpointId)?.branchConversationIds?.length, 0);
			await fs.access(f.snapshotPath);
		});
	});

	test('checkpoint cleanup failure does not skip persisting unlinked metadata or mask the original failure', async () => {
		await fixture(async f => {
			const retained: string[] = []; const retainFailure = new Error('Retention reporting failed'); const dropFailure = new Error('Checkpoint cleanup reporting failed');
			const actions = new ConversationActions(f.store, () => f.checkpointId,
				async (checkpointId, branchId) => { retained.push(branchId); await f.manager.attachToBranch(checkpointId, branchId); throw retainFailure; },
				async branchId => { await f.manager.detachBranch(branchId); throw dropFailure; });
			await assert.rejects(actions.branch(f.sourceId, 1), error => error instanceof AggregateError && error.errors[0] === retainFailure && error.errors.includes(dropFailure));
			assert.equal(f.disk.load(retained[0])?.summary.branch?.workspaceState, 'unlinked');
			assert.equal(f.manager.list(retained[0]).length, 0);
			await fs.access(f.snapshotPath);
		});
	});
});
