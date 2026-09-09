/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { ConversationStore, type ConversationSummary } from '../src/chat/ConversationStore';
import { ConversationStorage } from '../src/chat/ConversationStorage';
import type { ChatMessage } from '../src/chat/ChatPanel';

const indexKey = 'sota.conversations.index';
function message(content: string): ChatMessage { return { role: 'user', content, timestamp: 1 }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class Memento implements vscode.Memento {
	readonly values = new Map<string, object>();
	beforeUpdate?: (key: string, value: object | undefined) => Promise<void>;
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	keys(): string[] { return [...this.values.keys()]; }
	async update(key: string, value: object | undefined): Promise<void> {
		await this.beforeUpdate?.(key, value);
		if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); }
	}
}
async function fixture(disk: boolean, run: (store: ConversationStore, state: Memento, context: vscode.ExtensionContext) => Promise<void>): Promise<void> {
	const directory = disk ? await fsp.mkdtemp(path.join(tmpdir(), 'sota-permanent-delete-')) : undefined;
	const state = new Memento();
	const context = { globalState: state, workspaceState: new Memento(), ...(directory ? { globalStorageUri: vscode.Uri.file(directory) } : {}) } as unknown as vscode.ExtensionContext;
	const store = new ConversationStore(context);
	try { await store.ready; await run(store, state, context); }
	finally { store.dispose(); await store.flush().catch(() => {}); if (directory) { await fsp.rm(directory, { recursive: true, force: true }); } }
}

function deferDeletion(store: ConversationStore, state: Memento, id: string, fail = false) {
	const started = deferred(); const release = deferred();
	const wait = async () => { started.resolve(); await release.promise; if (fail) { throw new Error('deferred deletion failed'); } };
	const disk = (store as unknown as { disk?: ConversationStorage }).disk;
	if (disk) {
		const remove = disk.delete.bind(disk);
		disk.delete = async nextId => { await wait(); await remove(nextId); };
	} else {
		state.beforeUpdate = async (key, value) => { if (key === `sota.conversations.${id}` && value === undefined) { await wait(); } };
	}
	return { started, release };
}

suite('Permanent conversation deletion', () => {
	for (const disk of [true, false]) {
		test(`${disk ? 'disk' : 'fallback'} deletion survives disposal and shutdown flush waits for all host cleanup`, async () => {
			await fixture(disk, async (store, state, context) => {
				const record = store.create([message('delete during shutdown')]); store.delete(record.summary.id); await store.flush();
				const deletion = deferDeletion(store, state, record.summary.id);
				const cleanupStarted = deferred(); const releaseRecovery = deferred(); const releaseCheckpoints = deferred();
				const cleanup: string[] = []; const events: string[] = []; let flushed = false;
				const listener = store.onDidPermanentlyDelete(id => events.push(id));
				store.setPermanentDeleteCleanup(async id => {
					const durableBody = disk
						? new ConversationStorage(path.join(context.globalStorageUri.fsPath, 'conversations-v2')).load(id)
						: state.get(`sota.conversations.${id}`);
					assert.equal(durableBody, undefined);
					cleanup.push(id); cleanupStarted.resolve();
					await Promise.all([releaseRecovery.promise, releaseCheckpoints.promise]);
				});
				store.permanentDelete(record.summary.id); store.permanentDelete(record.summary.id);
				const shutdown = store.flush().then(() => { flushed = true; });
				try {
					await deletion.started.promise;
					// The real extension host disposes subscriptions before awaiting deactivate().
					store.dispose(); listener.dispose();
					assert.deepEqual({ cleanup, events, flushed }, { cleanup: [], events: [], flushed: false });
					deletion.release.resolve();
					await Promise.race([cleanupStarted.promise, shutdown]);
					assert.deepEqual({ cleanup, events, flushed }, { cleanup: [record.summary.id], events: [], flushed: false });
					releaseRecovery.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
					assert.equal(flushed, false, 'checkpoint cleanup must also settle before shutdown completes');
				} finally {
					deletion.release.resolve(); releaseRecovery.resolve(); releaseCheckpoints.resolve(); await shutdown;
				}
				assert.deepEqual({ cleanup, events, flushed }, { cleanup: [record.summary.id], events: [], flushed: true });
			});
		});

		test(`${disk ? 'disk' : 'fallback'} deletion failure during disposal never starts host cleanup`, async () => {
			await fixture(disk, async (store, state) => {
				const record = store.create([message('retain after failure')]); store.delete(record.summary.id); await store.flush();
				const deletion = deferDeletion(store, state, record.summary.id, true); const cleanup: string[] = [];
				store.setPermanentDeleteCleanup(async id => { cleanup.push(id); });
				store.permanentDelete(record.summary.id);
				const shutdown = assert.rejects(store.flush(), /deferred deletion failed/);
				try { await deletion.started.promise; store.dispose(); }
				finally { deletion.release.resolve(); await shutdown; }
				assert.deepEqual({ cleanup, messages: store.load(record.summary.id, true)?.messages }, { cleanup: [], messages: [message('retain after failure')] });
			});
		});
	}

	test('disk deletion publishes once after queued writes and durable removal, while pending messages stay hidden', async () => {
		await fixture(true, async (store, _state, context) => {
			const record = store.create([message('original')]); await store.flush();
			const disk = (store as unknown as { disk: ConversationStorage }).disk;
			const save = disk.save.bind(disk); const remove = disk.delete.bind(disk); const started = deferred(); const release = deferred();
			const events: string[] = []; let deleteCalls = 0;
			store.onDidPermanentlyDelete(id => {
				const reopened = new ConversationStorage(path.join(context.globalStorageUri.fsPath, 'conversations-v2'));
				assert.equal(reopened.load(id), undefined); events.push(id);
			});
			disk.save = async next => { if (next.summary.id === record.summary.id) { started.resolve(); await release.promise; } await save(next); };
			disk.delete = async id => { deleteCalls++; await remove(id); };
			store.update(record.summary.id, [message('latest queued content')]); await started.promise;
			store.delete(record.summary.id); store.permanentDelete(record.summary.id); store.permanentDelete(record.summary.id);
			store.update(record.summary.id, [message('must not resurrect')]); store.restore(record.summary.id);
			const survivor = store.create([message('surviving conversation')]);
			try { assert.deepEqual({ events, deleteCalls, record: store.load(record.summary.id, true), messages: store.loadMessages(record.summary.id, 0) }, { events: [], deleteCalls: 0, record: undefined, messages: [] }); }
			finally { release.resolve(); }
			await store.flush();
			assert.deepEqual({ events, deleteCalls, histories: store.list().map(summary => summary.id) }, { events: [record.summary.id], deleteCalls: 1, histories: [survivor.summary.id] });
		});
	});

	test('a failed disk deletion restores the latest Trash snapshot and only a successful retry publishes cleanup', async () => {
		await fixture(true, async (store, _state, context) => {
			const record = store.create([message('original')]); store.update(record.summary.id, [message('updated')]); store.delete(record.summary.id); await store.flush();
			const disk = (store as unknown as { disk: ConversationStorage }).disk; const remove = disk.delete.bind(disk);
			const events: string[] = []; let restored = false;
			store.onDidPermanentlyDelete(id => events.push(id)); store.onDidChange(() => { if (store.search({ scope: 'trash' }).total) { restored = true; } });
			disk.delete = async () => { throw new Error('denied delete'); };
			store.permanentDelete(record.summary.id); await assert.rejects(store.flush(), /denied delete/);
			const reopened = new ConversationStore(context); await reopened.ready;
			try { assert.deepEqual({ events, restored, current: store.load(record.summary.id, true)?.messages, stored: reopened.load(record.summary.id, true)?.messages }, { events: [], restored: true, current: [message('updated')], stored: [message('updated')] }); }
			finally { reopened.dispose(); }
			disk.delete = remove; store.permanentDelete(record.summary.id); await store.flush();
			assert.deepEqual({ events, record: store.load(record.summary.id, true) }, { events: [record.summary.id], record: undefined });
		});
	});

	for (const position of ['index', 'body'] as const) {
		test(`fallback ${position} deletion failure restores backing state and never publishes cleanup`, async () => {
			await fixture(false, async (store, state, context) => {
				const record = store.create([message('retained transcript')]); store.delete(record.summary.id); await store.flush();
				const key = `sota.conversations.${record.summary.id}`; const events: string[] = []; let failed = false;
				store.onDidPermanentlyDelete(id => events.push(id));
				state.beforeUpdate = async (nextKey, value) => {
					if (!failed && (position === 'index' ? nextKey === indexKey : nextKey === key && value === undefined)) {
						failed = true;
						// Some Memento implementations update their cache before persistence fails.
						if (value === undefined) { state.values.delete(nextKey); } else { state.values.set(nextKey, value); }
						throw new Error(`failed ${position} removal`);
					}
				};
				store.permanentDelete(record.summary.id); store.permanentDelete(record.summary.id);
				const survivor = store.create([message('concurrent save')]); await assert.rejects(store.flush(), new RegExp(`failed ${position} removal`));
				const reopened = new ConversationStore(context); await reopened.ready;
				try { assert.deepEqual({ events, trash: reopened.load(record.summary.id, true)?.messages, survivor: reopened.load(survivor.summary.id)?.messages, visible: store.search({ scope: 'trash' }).items.map(summary => summary.id) }, { events: [], trash: [message('retained transcript')], survivor: [message('concurrent save')], visible: [record.summary.id] }); }
				finally { reopened.dispose(); }
				store.permanentDelete(record.summary.id); await store.flush();
				assert.deepEqual({ events, body: state.get(key), index: state.get<ConversationSummary[]>(indexKey).map(summary => summary.id) }, { events: [record.summary.id], body: undefined, index: [survivor.summary.id] });
			});
		});
	}

	test('fallback deletion waits for an older delayed save and both deletion writes', async () => {
		await fixture(false, async (store, state) => {
			const firstWrite = deferred(); const releaseWrite = deferred(); const deletion = deferred(); const releaseDeletion = deferred();
			let blocked = false; const events: string[] = [];
			state.beforeUpdate = async (key, value) => {
				if (!blocked) { blocked = true; firstWrite.resolve(); await releaseWrite.promise; }
				if (key !== indexKey && value === undefined) { deletion.resolve(); await releaseDeletion.promise; }
			};
			const record = store.create([message('initial')]); await firstWrite.promise;
			store.update(record.summary.id, [message('queued update')]); store.delete(record.summary.id); store.permanentDelete(record.summary.id);
			store.onDidPermanentlyDelete(id => { assert.equal(state.get(`sota.conversations.${id}`), undefined); events.push(id); });
			try { assert.deepEqual(events, []); } finally { releaseWrite.resolve(); }
			await deletion.promise;
			try { assert.deepEqual(events, []); } finally { releaseDeletion.resolve(); }
			await store.flush();
			assert.deepEqual({ events, messages: store.loadMessages(record.summary.id, 0), index: state.get(indexKey) }, { events: [record.summary.id], messages: [], index: [] });
		});
	});

	test('fallback rollback failure retains the transcript in memory and keeps the error until retry succeeds', async () => {
		await fixture(false, async (store, state) => {
			const record = store.create([message('recoverable in this window')]); store.delete(record.summary.id); await store.flush();
			const key = `sota.conversations.${record.summary.id}`; const events: string[] = [];
			store.onDidPermanentlyDelete(id => events.push(id));
			state.beforeUpdate = async nextKey => { if (nextKey === key) { throw new Error('persistent Memento failure'); } };
			store.permanentDelete(record.summary.id); await assert.rejects(store.flush(), /stored Trash record could not be restored/);
			assert.deepEqual({ events, record: store.load(record.summary.id, true)?.messages }, { events: [], record: [message('recoverable in this window')] });
			state.beforeUpdate = undefined; store.permanentDelete(record.summary.id); await store.flush();
			assert.deepEqual(events, [record.summary.id]);
		});
	});
});
