/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { ConversationStore } from '../src/chat/ConversationStore';
import { ConversationStorage } from '../src/chat/ConversationStorage';
import type { ChatMessage } from '../src/chat/ChatPanel';
function message(content: string): ChatMessage { return { role: 'user', content, timestamp: 1 }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class Memento implements vscode.Memento {
	readonly values = new Map<string, unknown>();
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	keys(): string[] { return [...this.values.keys()]; }
	async update(key: string, value: unknown): Promise<void> { if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); } }
}
function internals(store: ConversationStore) { return store as unknown as { disk: ConversationStorage; scanDeletions(): void; pendingRecords: Map<string, unknown>; failedWrites: Map<string, Error> }; }
async function fixture(run: (first: ConversationStore, second: ConversationStore, context: vscode.ExtensionContext) => Promise<void>): Promise<void> {
	const directory = await fsp.mkdtemp(path.join(tmpdir(), 'sota-store-delete-fence-'));
	const context = { globalState: new Memento(), workspaceState: new Memento(), globalStorageUri: vscode.Uri.file(directory) } as unknown as vscode.ExtensionContext;
	const first = new ConversationStore(context); const second = new ConversationStore({ ...context, workspaceState: new Memento() } as vscode.ExtensionContext);
	try { await Promise.all([first.ready, second.ready]); await run(first, second, context); }
	finally { first.dispose(); second.dispose(); await Promise.all([first.flush().catch(() => {}), second.flush().catch(() => {})]); await fsp.rm(directory, { recursive: true, force: true }); }
}

suite('Cross-window conversation deletion reconciliation', () => {
	test('external deletion retires failed overlays and every read/search path without poisoning flush', async () => {
		await fixture(async (first, second) => {
			const record = first.create([message('original')]); await first.flush(); const id = record.summary.id;
			const disk = internals(second).disk; const save = disk.save.bind(disk); disk.save = async () => { throw new Error('temporary write failure'); };
			second.update(id, [message('pending searchable body')]); await assert.rejects(second.flush(), /temporary write failure/);
			first.delete(id); await first.flush(); first.permanentDelete(id); await first.flush();
			const order: string[] = []; second.onDidDelete(nextId => { assert.equal(nextId, id); order.push('cancel'); assert.equal(second.load(id, true), undefined); });
			second.setPermanentDeleteCleanup(async nextId => { assert.equal(nextId, id); order.push('cleanup'); });
			assert.equal(second.load(id, true), undefined); await second.flush(); disk.save = save;
			assert.deepEqual(order, ['cancel', 'cleanup']); assert.equal(internals(second).pendingRecords.has(id), false); assert.equal(internals(second).failedWrites.has(id), false);
			second.update(id, [message('resurrection')]); second.rename(id, 'resurrection'); second.restore(id); second.archive(id); second.setPinned(id, true);
			assert.deepEqual(second.loadMessages(id, 0), []); assert.deepEqual(second.list(), []);
			for (const query of ['', 'original', 'pending', 'resurrection']) { assert.equal(second.search({ query, scope: 'all' }).total, 0); assert.equal((await second.searchAsync({ query, scope: 'all' })).total, 0); }
			await second.flush(); assert.equal(disk.load(id), undefined);
		});
	});

	test('shutdown flush drains cleanup appended when an in-flight stale save discovers deletion', async () => {
		await fixture(async (first, second) => {
			const record = first.create([message('original')]); await first.flush(); const id = record.summary.id;
			const disk = internals(second).disk; const save = disk.save.bind(disk); const started = deferred(); const releaseSave = deferred(); const cleanupStarted = deferred(); const releaseCleanup = deferred();
			disk.save = async next => { started.resolve(); await releaseSave.promise; await save(next); };
			second.setPermanentDeleteCleanup(async () => { cleanupStarted.resolve(); await releaseCleanup.promise; }); await second.flush();
			second.update(id, [message('late content')]); await started.promise;
			first.delete(id); await first.flush(); first.permanentDelete(id); await first.flush();
			let flushed = false; const shutdown = second.flush().then(() => { flushed = true; }); second.dispose(); releaseSave.resolve();
			try { await cleanupStarted.promise; await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(flushed, false); }
			finally { releaseSave.resolve(); releaseCleanup.resolve(); await shutdown; }
			assert.equal(flushed, true); assert.equal(internals(second).pendingRecords.has(id), false);
		});
	});

	test('lifecycle observation cancels before a slow pending save completes and replays once per window', async () => {
		await fixture(async (first, second, context) => {
			const record = first.create([message('original')]); await first.flush(); const id = record.summary.id;
			const disk = internals(second).disk; const save = disk.save.bind(disk); const started = deferred(); const release = deferred(); const cancelled = deferred(); const events: string[] = [];
			disk.save = async next => { started.resolve(); await release.promise; await save(next); };
			second.onDidDelete(() => { events.push('cancel'); cancelled.resolve(); }); second.setPermanentDeleteCleanup(async () => { events.push('cleanup'); }); await second.flush();
			second.update(id, [message('late content')]); await started.promise;
			first.delete(id); await first.flush(); first.permanentDelete(id); await first.flush();
			internals(second).scanDeletions();
			try { await cancelled.promise; assert.deepEqual(events, ['cancel']); }
			finally { release.resolve(); await second.flush(); }
			internals(second).scanDeletions(); await second.flush(); assert.deepEqual(events, ['cancel', 'cleanup']);
			const third = new ConversationStore(context); let replayed = 0;
			try { await third.ready; third.setPermanentDeleteCleanup(async nextId => { assert.equal(nextId, id); replayed++; }); await third.flush(); assert.equal(replayed, 1); }
			finally { third.dispose(); await third.flush(); }
		});
	});

	test('a failed live barrier hides but retains another window pending transcript for retry', async () => {
		await fixture(async (first, second) => {
			const record = first.create([message('original')]); await first.flush(); const id = record.summary.id;
			internals(second).disk.save = async () => { throw new Error('pending write'); }; second.update(id, [message('unsaved retained')]); await assert.rejects(second.flush());
			first.delete(id); await first.flush(); const raw = internals(first).disk as unknown as { atomicWrite(file: string, body: string): Promise<void> }; const write = raw.atomicWrite.bind(raw); const barrier = deferred(); const release = deferred();
			raw.atomicWrite = async (file, body) => { if (file.endsWith('deletion.json') && JSON.parse(body).state === 'deleted') { barrier.resolve(); await release.promise; throw new Error('commit failed'); } await write(file, body); };
			first.permanentDelete(id); const failure = assert.rejects(first.flush(), /commit failed/);
			try { await barrier.promise; assert.equal(second.load(id, true), undefined); assert.equal((await second.searchAsync({ scope: 'all', query: 'unsaved' })).total, 0); assert.ok(internals(second).pendingRecords.has(id)); }
			finally { release.resolve(); await failure; }
			assert.deepEqual(second.load(id)?.messages, [message('unsaved retained')]);
		});
	});

	test('another window committing deletion resolves a locally failed queued delete as final', async () => {
		await fixture(async (first, second) => {
			const record = first.create([message('original')]); first.delete(record.summary.id); await first.flush();
			const started = deferred(); const release = deferred(); const events: string[] = [];
			internals(second).disk.delete = async () => { started.resolve(); await release.promise; throw new Error('local delete failed'); };
			second.setPermanentDeleteCleanup(async id => { events.push(id); }); await second.flush();
			second.permanentDelete(record.summary.id); await started.promise;
			try { first.permanentDelete(record.summary.id); await first.flush(); }
			finally { release.resolve(); await second.flush(); }
			assert.deepEqual(events, [record.summary.id]); assert.equal(second.load(record.summary.id, true), undefined);
		});
	});

	test('an async search rechecks metadata matches after another body lookup yields', async () => {
		await fixture(async (first, second) => {
			const target = first.create([message('needle in title')]); const other = first.create([message('other title')]); await first.flush();
			const searching = deferred(); const release = deferred(); const disk = internals(second).disk; const matches = disk.matches.bind(disk);
			disk.listAsync = async () => [target.summary, other.summary]; disk.matches = async (id, query, signal) => { searching.resolve(); await release.promise; return matches(id, query, signal); };
			const result = second.searchAsync({ query: 'needle' }); await searching.promise;
			first.delete(target.summary.id); await first.flush(); first.permanentDelete(target.summary.id); await first.flush(); release.resolve();
			assert.equal((await result).total, 0);
		});
	});

	test('damaged marker metadata isolates a pending record while healthy History remains usable', async () => {
		await fixture(async (first, second, context) => {
			const damaged = first.create([message('damaged title')]); const healthy = first.create([message('healthy title')]); await first.flush();
			internals(second).disk.save = async () => { throw new Error('retain pending copy'); };
			second.update(damaged.summary.id, [message('pending body')]); await assert.rejects(second.flush());
			const marker = path.join(context.globalStorageUri.fsPath, 'conversations-v2', '.lifecycle', createHash('sha256').update(damaged.summary.id).digest('hex'), 'deletion.json');
			await fsp.writeFile(marker, '{damaged');
			assert.deepEqual(second.list().map(summary => summary.id), [healthy.summary.id]);
			assert.deepEqual((await second.searchAsync()).items.map(summary => summary.id), [healthy.summary.id]);
			assert.equal((await second.searchAsync({ query: 'pending' })).total, 0);
			assert.ok(internals(second).pendingRecords.has(damaged.summary.id)); assert.ok(second.recoveryIssues.some(issue => issue.path === marker));
			assert.throws(() => second.load(damaged.summary.id)); assert.deepEqual(second.load(healthy.summary.id)?.messages, [message('healthy title')]);
		});
	});

	test('startup skips committed legacy transcripts and retains migration sources behind a live barrier', async () => {
		await fixture(async (first, _second, context) => {
			const record = first.create([message('legacy retained')]); await first.flush(); const id = record.summary.id;
			first.delete(id); await first.flush(); first.permanentDelete(id); await first.flush();
			await context.globalState.update('sota.conversations.index', [record.summary]); await context.globalState.update(`sota.conversations.${id}`, record.messages);
			const third = new ConversationStore(context);
			try { await third.ready; assert.deepEqual(third.list(), []); assert.equal(context.globalState.get(`sota.conversations.${id}`), undefined); }
			finally { third.dispose(); await third.flush(); }
			const pendingId = 'legacy-pending'; const hash = createHash('sha256').update(pendingId).digest('hex'); const folder = path.join(context.globalStorageUri.fsPath, 'conversations-v2', '.lifecycle', hash);
			await fsp.mkdir(folder, { recursive: true }); await fsp.writeFile(path.join(folder, 'deletion.json'), JSON.stringify({ version: 1, id: pendingId, state: 'pending', owner: `.writer-${(process as NodeJS.Process).pid}-abcd`, deletedAt: Date.now() }));
			await context.globalState.update('sota.conversations.index', [{ ...record.summary, id: pendingId }]); await context.globalState.update(`sota.conversations.${pendingId}`, record.messages);
			const fourth = new ConversationStore(context);
			try { await fourth.ready; assert.equal(fourth.load(pendingId), undefined); assert.deepEqual(context.globalState.get(`sota.conversations.${pendingId}`), record.messages); assert.equal(fs.existsSync(path.join(context.globalStorageUri.fsPath, 'conversations-v2', hash)), false); }
			finally { fourth.dispose(); await fourth.flush(); }
		});
	});
});
