/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { activateConversationHistory } from '../src/chat/activateConversationHistory';
import { ConversationStorage } from '../src/chat/ConversationStorage';
import { ConversationStore } from '../src/chat/ConversationStore';
import type { ChatMessage } from '../src/chat/ChatPanel';

const hostProcess = process as NodeJS.Process;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(complete => { resolve = complete; });
	return { promise, resolve };
}

async function fixture(run: (value: {
	context: vscode.ExtensionContext; directory: string; values: Map<string, unknown>; original: ChatMessage;
	started: Promise<void>; finish(error?: Error): void; warnings: string[]; errors: string[];
}) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-activation-'));
	const original: ChatMessage = { role: 'user', content: [{ type: 'text', text: 'Keep my original conversation' }, { type: 'image', mimeType: 'image/png', base64Data: Buffer.alloc(16384, 42).toString('base64') }], timestamp: 1 };
	const values = new Map<string, unknown>([['sota.conversations.index', [{ id: 'original', title: 'Original', messageCount: 1, createdAt: 1, updatedAt: 1 }]], ['sota.conversations.original', [original]]]);
	const state = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: unknown) => { if (value === undefined) { values.delete(key); } else { values.set(key, value); } } };
	const subscriptions: vscode.Disposable[] = [];
	const context = { globalStorageUri: vscode.Uri.file(directory), globalState: state, workspaceState: { get: () => undefined, update: async () => {} }, subscriptions } as unknown as vscode.ExtensionContext;
	const gate = deferred(); const started = deferred(); let failure: Error | undefined;
	const save = ConversationStorage.prototype.save;
	ConversationStorage.prototype.save = async function (...args) { started.resolve(); await gate.promise; if (failure) { throw failure; } await save.apply(this, args); };
	const warnings: string[] = []; const errors: string[] = [];
	const originalWarning = vscode.window.showWarningMessage, originalError = vscode.window.showErrorMessage;
	vscode.window.showWarningMessage = (async (text: string) => { warnings.push(text); return undefined; }) as typeof vscode.window.showWarningMessage;
	vscode.window.showErrorMessage = (async (text: string) => { errors.push(text); return undefined; }) as typeof vscode.window.showErrorMessage;
	const unhandled: unknown[] = []; const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
	hostProcess.on('unhandledRejection', onUnhandled);
	try {
		await run({ context, directory, values, original, started: started.promise, finish: error => { failure = error; gate.resolve(); }, warnings, errors });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(unhandled, [], 'background observers must handle notification and migration failures');
	}
	finally {
		gate.resolve();
		for (const disposable of subscriptions) { disposable.dispose(); }
		for (const store of subscriptions.filter((item): item is ConversationStore => item instanceof ConversationStore)) { await store.ready.catch(() => {}); await store.flush().catch(() => {}); }
		hostProcess.off('unhandledRejection', onUnhandled);
		ConversationStorage.prototype.save = save;
		vscode.window.showWarningMessage = originalWarning; vscode.window.showErrorMessage = originalError;
		await fs.rm(directory, { recursive: true, force: true });
	}
}

suite('Conversation history activation', () => {
	test('registration and queued user edits proceed while image-history migration is blocked', async () => {
		await fixture(async f => {
			const store = activateConversationHistory(f.context);
			assert.ok(store instanceof ConversationStore, 'activation returns its usable store synchronously');
			let changes = 0; f.context.subscriptions.push(store.onDidChange(() => { changes++; }));
			let ready = false; void store.ready.then(() => { ready = true; });
			const pending = store.load('original'); assert.ok(pending?.writeToken);
			const edited = [...pending.messages, { role: 'assistant' as const, content: 'Written during migration', timestamp: 2 }];
			store.update('original', edited, undefined, undefined, undefined, undefined, pending.writeToken);
			const fresh = store.create([{ role: 'user', content: 'New chat while loading', timestamp: 3 }]);
			await f.started;
			assert.equal(ready, false); assert.equal(f.values.has('sota.conversations.original'), true);
			assert.deepEqual(store.load('original')?.messages, edited); assert.ok(store.list().some(item => item.id === fresh.summary.id));
			const beforeSettlement = changes; f.finish(); await store.ready; await store.flush();
			const disk = new ConversationStorage(path.join(f.directory, 'conversations-v2'));
			assert.deepEqual(disk.load('original')?.messages, edited); assert.deepEqual(disk.load(fresh.summary.id)?.messages, fresh.messages);
			assert.equal(f.values.has('sota.conversations.original'), false); assert.ok(changes > beforeSettlement, 'already registered history views refresh when migration settles');
			assert.deepEqual({ warnings: f.warnings, errors: f.errors }, { warnings: [], errors: [] });
		});
	});

	test('failed background migration preserves accessible pending history, reports recovery and refreshes subscribers', async () => {
		await fixture(async f => {
			const store = activateConversationHistory(f.context); let changes = 0;
			f.context.subscriptions.push(store.onDidChange(() => { changes++; }));
			const fresh = store.create([]); await f.started; const beforeSettlement = changes;
			f.finish(new Error('ENOSPC: no space left on device')); await assert.rejects(store.ready, /ENOSPC/); await assert.rejects(store.flush(), /ENOSPC/);
			assert.deepEqual(store.load('original')?.messages, [f.original]); assert.equal(store.load(fresh.summary.id)?.messages.length, 0);
			assert.equal(f.values.has('sota.conversations.original'), true); assert.ok(changes > beforeSettlement);
			assert.equal(f.warnings.filter(text => text.includes('Chat remains available')).length, 1);
		});
	});

	for (const fail of [false, true]) {
		test(`disposal before migration ${fail ? 'fails' : 'completes'} drains writes without late UI events or unhandled rejections`, async () => {
			await fixture(async f => {
				const store = activateConversationHistory(f.context); let changes = 0;
				f.context.subscriptions.push(store.onDidChange(() => { changes++; }));
				const unhandled: unknown[] = []; const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
				hostProcess.on('unhandledRejection', onUnhandled);
				try {
					await f.started; for (const disposable of f.context.subscriptions) { disposable.dispose(); }
					const beforeSettlement = changes; f.finish(fail ? new Error('Disposed storage failure') : undefined);
					if (fail) { await assert.rejects(store.ready, /Disposed storage failure/); await assert.rejects(store.flush(), /Disposed storage failure/); }
					else { await store.ready; await store.flush(); }
					await new Promise<void>(resolve => setImmediate(resolve));
					assert.deepEqual({ changes, warnings: f.warnings, errors: f.errors, unhandled }, { changes: beforeSettlement, warnings: [], errors: [], unhandled: [] });
					assert.deepEqual(store.load('original')?.messages, [f.original]);
					assert.equal(f.values.has('sota.conversations.original'), fail);
				} finally { hostProcess.off('unhandledRejection', onUnhandled); }
			});
		});
	}

	test('rejected warning delivery is observed without losing failed migration history', async () => {
		await fixture(async f => {
			vscode.window.showWarningMessage = (() => Promise.reject(new Error('Window closed'))) as typeof vscode.window.showWarningMessage;
			const store = activateConversationHistory(f.context); await f.started;
			f.finish(new Error('Migration unavailable')); await assert.rejects(store.ready, /Migration unavailable/);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(store.load('original')?.messages, [f.original]); assert.equal(f.values.has('sota.conversations.original'), true);
		});
	});

	test('failing subscribers and diagnostics do not replace the migration error or reject background observers', async () => {
		await fixture(async f => {
			vscode.window.showWarningMessage = (() => { throw new Error('Closing warning host'); }) as typeof vscode.window.showWarningMessage;
			vscode.window.showErrorMessage = (() => Promise.reject(new Error('Closing error host'))) as typeof vscode.window.showErrorMessage;
			const store = activateConversationHistory(f.context); await f.started;
			f.context.subscriptions.push(store.onDidChange(() => { throw new Error('History view unavailable'); }));
			const failure = new Error('Original migration failure'); f.finish(failure);
			await assert.rejects(store.ready, error => error === failure); await assert.rejects(store.flush(), error => error === failure);
			await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual(store.load('original')?.messages, [f.original]); assert.equal(f.values.has('sota.conversations.original'), true);
		});
	});

	test('initial damaged-history diagnostics remain available when registration is immediate', async () => {
		await fixture(async f => {
			const folder = path.join(f.directory, 'conversations-v2', createHash('sha256').update('damaged').digest('hex')); await fs.mkdir(folder, { recursive: true });
			const manifest = path.join(folder, 'manifest.json'); await fs.writeFile(manifest, '{ damaged');
			const store = activateConversationHistory(f.context);
			assert.ok(store.recoveryIssues.some(issue => issue.path === manifest)); assert.ok(f.warnings.some(message => message.includes(manifest)));
			await f.started; f.finish(); await store.ready;
			assert.deepEqual(store.load('original')?.messages, [f.original]); assert.equal(await fs.readFile(manifest, 'utf8'), '{ damaged');
		});
	});
});
