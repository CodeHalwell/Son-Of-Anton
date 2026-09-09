/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as vscode from 'vscode';
import { watchConversationLifecycle } from '../src/chat/ConversationLifecycleWatcher';

type Kind = 'create' | 'change' | 'delete';
type Callback = () => void;
type FileCallback = (uri: vscode.Uri) => void;
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 60));

suite('Conversation lifecycle watcher', () => {
	const host = require('vscode') as typeof vscode;
	let restore: () => void;
	let pattern: { baseUri: vscode.Uri; pattern: string } | undefined;
	let listeners: Map<Kind, FileCallback>;
	let savedListeners: Map<Kind, FileCallback>;
	let watcherDisposals: number;
	let listenerDisposals: number;
	let failSubscription: Kind | undefined;
	let subscriptions: vscode.Disposable[];

	setup(() => {
		const original = { RelativePattern: host.RelativePattern, watcher: host.workspace.createFileSystemWatcher };
		pattern = undefined; listeners = new Map(); savedListeners = new Map(); watcherDisposals = 0; listenerDisposals = 0; failSubscription = undefined; subscriptions = [];
		const subscribe = (kind: Kind, callback: FileCallback): vscode.Disposable => {
			if (failSubscription === kind) { throw new Error('Watcher subscription failed'); }
			listeners.set(kind, callback); savedListeners.set(kind, callback);
			return { dispose: () => { listenerDisposals++; listeners.delete(kind); } };
		};
		Object.assign(host, { RelativePattern: class {
			readonly baseUri: vscode.Uri; readonly pattern: string;
			constructor(baseUri: vscode.Uri, pattern: string) { this.baseUri = baseUri; this.pattern = pattern; }
		} });
		const event = (kind: Kind): vscode.Event<vscode.Uri> => listener => subscribe(kind, uri => listener(uri));
		host.workspace.createFileSystemWatcher = next => {
			assert.notEqual(typeof next, 'string'); pattern = next as vscode.RelativePattern;
			return {
				ignoreCreateEvents: false, ignoreChangeEvents: false, ignoreDeleteEvents: false,
				onDidCreate: event('create'),
				onDidChange: event('change'),
				onDidDelete: event('delete'),
				dispose: () => { watcherDisposals++; },
			};
		};
		restore = () => { Object.assign(host, { RelativePattern: original.RelativePattern }); host.workspace.createFileSystemWatcher = original.watcher; };
	});
	teardown(() => { for (const subscription of subscriptions) { subscription.dispose(); } restore(); });
	function watch(directory: string, callback: Callback): vscode.Disposable {
		const subscription = watchConversationLifecycle(directory, callback); subscriptions.push(subscription); return subscription;
	}
	function emit(kind: Kind, relative = `${'a'.repeat(64)}/deletion.json`): void {
		listeners.get(kind)!(host.Uri.file(path.join(pattern!.baseUri.fsPath, relative)));
	}

	test('scopes an absolute RelativePattern to lifecycle markers even when the folder does not exist', async () => {
		const root = await fs.mkdtemp(path.join(tmpdir(), 'sota-lifecycle-watch-'));
		try {
			const directory = path.join(root, 'not-created', 'conversations-v2'); let reconciliations = 0;
			watch(directory, () => { reconciliations++; });
			assert.deepEqual(pattern && { root: pattern.baseUri.fsPath, scheme: pattern.baseUri.scheme, glob: pattern.pattern }, { root: path.join(directory, '.lifecycle'), scheme: 'file', glob: '**' });
			await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
			await settle(); assert.equal(reconciliations, 1, 'initial reconciliation covers setup events without creating storage');
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});

	test('coalesces create/change/delete bursts and continues observing later events', async () => {
		let calls = 0; watch(path.join(tmpdir(), 'sota-watch'), () => { calls++; });
		for (const kind of listeners.keys()) { emit(kind); emit(kind); }
		assert.equal(calls, 0); await settle(); assert.equal(calls, 1);
		for (const kind of ['create', 'change', 'delete'] as const) {
			emit(kind); emit(kind); await settle();
		}
		assert.equal(calls, 4);
	});

	test('disposal clears pending callbacks, subscriptions and watcher exactly once', async () => {
		let calls = 0; const subscription = watch(path.join(tmpdir(), 'sota-watch'), () => { calls++; });
		await settle(); emit('change'); subscription.dispose(); subscription.dispose();
		// Simulate already-dispatched host events arriving after their listener is removed.
		for (const callback of savedListeners.values()) { callback(host.Uri.file(pattern!.baseUri.fsPath)); }
		await settle();
		assert.deepEqual({ calls, watcherDisposals, listenerDisposals, listeners: listeners.size }, { calls: 1, watcherDisposals: 1, listenerDisposals: 3, listeners: 0 });
	});

	test('disposal before the initial reconciliation prevents all callbacks', async () => {
		let calls = 0; watch(path.join(tmpdir(), 'sota-watch'), () => { calls++; }).dispose(); await settle();
		assert.equal(calls, 0);
	});

	test('partial subscription failure releases the watcher and every registered listener', async () => {
		failSubscription = 'change'; let calls = 0;
		assert.throws(() => watch(path.join(tmpdir(), 'sota-watch'), () => { calls++; }), /subscription failed/);
		for (const callback of savedListeners.values()) { callback(host.Uri.file(pattern!.baseUri.fsPath)); } await settle();
		assert.deepEqual({ calls, watcherDisposals, listenerDisposals, listeners: listeners.size }, { calls: 0, watcherDisposals: 1, listenerDisposals: 1, listeners: 0 });
	});

	test('root resume and coalesced container events reconcile without responding to ticket or payload churn', async () => {
		let calls = 0; watch(path.join(tmpdir(), 'sota-watch'), () => { calls++; }); await settle();
		emit('create', ''); await settle();
		emit('delete', 'a'.repeat(64)); await settle();
		assert.equal(calls, 3);
		for (const relative of [`${'a'.repeat(64)}/.ticket-123`, `${'a'.repeat(64)}/deletion.json.tmp`, `${'a'.repeat(64)}/nested/deletion.json`, '../payload.json', 'not-a-conversation/deletion.json']) { emit('change', relative); }
		await settle(); assert.equal(calls, 3);
	});

	test('the actual VS Code relative glob matcher includes root resume events and excludes transcript folders', () => {
		const { parse } = require('../../../src/vs/base/common/glob.ts') as { parse: (pattern: { base: string; pattern: string }) => (candidate: string) => boolean };
		watch(path.join(tmpdir(), 'sota-watch'), () => {});
		const base = pattern!.baseUri.fsPath; const match = parse({ base, pattern: pattern!.pattern });
		assert.deepEqual([
			match(base), match(path.join(base, 'a'.repeat(64))), match(path.join(base, 'a'.repeat(64), 'deletion.json')), match(path.join(base, '..', 'payload.json')),
			parse({ base, pattern: '*/deletion.json' })(base),
		], [true, true, true, false, false]);
	});
});
