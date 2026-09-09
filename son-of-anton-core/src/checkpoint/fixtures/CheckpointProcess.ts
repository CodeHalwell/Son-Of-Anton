/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { CheckpointManager, type Checkpoint } from '../CheckpointManager';
import { CheckpointIndexStorage } from '../CheckpointIndexStorage';
import { FileSnapshotStore, type FileSnapshot } from '../FileSnapshotStore';
import { withCheckpointLock } from '../ProcessFileLock';

/** Static subprocess scenarios receive only data through argv/IPC. */
const options = JSON.parse(process.argv[2]) as { root: string; storage: string; mode: 'capture' | 'pin' | 'restore' | 'lock' | 'index-lock'; expectDeleted?: boolean; conversationId?: string; checkpointId?: string; crash?: boolean; snapshot?: FileSnapshot; legacy?: Checkpoint[] };
const wait = () => new Promise<void>(resolve => process.once('message', () => resolve()));
const send = (value: unknown) => process.send?.(value);
async function run(): Promise<void> {
	const root = fs.realpathSync.native(options.root);
	if (options.mode === 'lock' || options.mode === 'index-lock') {
		const directory = options.mode === 'lock' ? path.join(options.storage, 'lock-test') : path.join(options.storage, 'index-v1', createHash('sha256').update(root).digest('hex'));
		await withCheckpointLock(directory, async () => { send({ stage: 'ready' }); await wait(); if (options.crash) { process.exit(0); } });
	} else if (options.mode === 'pin') {
		const index = new CheckpointIndexStorage(options.storage, root, () => options.legacy ?? [], () => {});
		const pin = await index.pin(options.checkpointId!); send({ stage: 'ready' }); await wait();
		if (options.crash) { process.exit(0); } await pin.release();
	} else if (options.mode === 'restore') {
		const store = new FileSnapshotStore(root, options.storage);
		await store.restore(options.snapshot!, async () => { send({ stage: 'ready' }); await wait(); return true; });
	} else {
		const manager = new CheckpointManager({ load: () => ({ messages: [], summary: {} }), update() {} }, { get: <T>() => (options.legacy ?? []) as T, update: async () => { throw new Error('Memento is a read-only migration source.'); } }, {
			storageRoot: options.storage, getWorkspaceRoot: () => root, config: { get: <T>(_key: string, fallback?: T) => fallback as T }, confirmRestore: async () => true, notifier: { info() {}, warn(message) { throw new Error(message); }, error(message) { throw new Error(message); } },
		});
		manager.listAll(); send({ stage: 'ready' }); await wait();
		if (options.expectDeleted) {
			let rejected = false;
			try { await manager.capture(options.conversationId!, 0, 'process capture'); } catch (error) { if (!/permanently deleted/.test(String(error))) { throw error; } rejected = true; }
			if (!rejected) { throw new Error('Deleted conversation capture unexpectedly succeeded.'); }
		} else {
			const checkpoint = await manager.capture(options.conversationId!, 0, 'process capture'); if (!checkpoint) { throw new Error('Checkpoint capture failed'); }
			send({ stage: 'captured', checkpoint });
		}
		manager.dispose();
	}
	process.disconnect();
}
void run().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
