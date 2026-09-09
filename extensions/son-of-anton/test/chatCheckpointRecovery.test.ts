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
import { CheckpointManager } from 'son-of-anton-core/checkpoint/CheckpointManager';
import type { LlmClient } from 'son-of-anton-core/llm/LlmClient';
import { ChatSession } from '../src/chat/ChatPanel';
import { ChatViewProvider } from '../src/chat/ChatViewProvider';
import { ConversationActions } from '../src/chat/ConversationActions';
import { ConversationStore } from '../src/chat/ConversationStore';
import type { ToolRegistry } from '../src/tools/registry';

class Memento implements vscode.Memento {
	private values = new Map<string, unknown>();
	keys() { return [...this.values.keys()]; }
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	async update(key: string, value: unknown): Promise<void> { if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); } }
}

async function fixture(run: (value: {
	store: ConversationStore; manager: CheckpointManager; context: vscode.ExtensionContext;
	first: string; second: string; checkpoint: string; index: string; healthy: string; workspace: string; warnings: string[]; errors: string[];
}) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-chat-checkpoint-recovery-')); const workspace = path.join(directory, 'workspace');
	await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'file.txt'), 'Keep these workspace files');
	const state = new Memento(); const context = { globalState: state, workspaceState: new Memento(), globalStorageUri: vscode.Uri.file(path.join(directory, 'storage')), extensionUri: vscode.Uri.file(directory), subscriptions: [] } as unknown as vscode.ExtensionContext;
	const store = new ConversationStore(context); const warnings: string[] = []; const errors: string[] = [];
	const storageRoot = path.join(directory, 'checkpoints');
	const manager = new CheckpointManager(store, state, { storageRoot, getWorkspaceRoot: () => workspace, config: { get: <T>(_key: string, fallback?: T) => fallback as T }, confirmRestore: async () => { assert.fail('Damaged metadata must never reach restore confirmation'); }, notifier: { info() {}, warn: message => { warnings.push(message); }, error: message => { errors.push(message); } } });
	const showError = vscode.window.showErrorMessage, warn = console.warn;
	vscode.window.showErrorMessage = (async (message: string) => { errors.push(message); return undefined; }) as typeof vscode.window.showErrorMessage;
	console.warn = () => {};
	try {
		await store.ready;
		const first = store.create([{ role: 'user', content: 'First history', timestamp: 1 }]); const second = store.create([{ role: 'user', content: 'Second history', timestamp: 2 }]); await store.flush(); store.rememberActive(first.summary.id);
		const checkpoint = await manager.capture(first.summary.id, 0, 'Before change'); assert.ok(checkpoint);
		const index = path.join(storageRoot, 'index-v1', createHash('sha256').update(await fs.realpath(workspace)).digest('hex'), 'index.json'); const healthy = await fs.readFile(index, 'utf8'); await fs.writeFile(index, '{ damaged');
		await run({ store, manager, context, first: first.summary.id, second: second.summary.id, checkpoint: checkpoint.id, index, healthy, workspace, warnings, errors });
	} finally { manager.dispose(); store.dispose(); await store.flush().catch(() => {}); vscode.window.showErrorMessage = showError; console.warn = warn; await fs.rm(directory, { recursive: true, force: true }); }
}

suite('Chat checkpoint index recovery', () => {
	test('real sidebar session construction, bootstrap and history switching survive damaged checkpoint metadata', async () => {
		await fixture(async f => {
			const prototype = ChatSession.prototype as unknown as Record<string, unknown>;
			const overrides = { getHtmlContent: () => '<html>Chat</html>', refreshConnectionState: async () => {}, refreshWorkspaceIndex: async () => {}, migrateLegacyAutoApprove: async () => {}, postProviderCatalog: () => {} };
			const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, prototype[key]])); Object.assign(prototype, overrides);
			const eventNames = ['onDidChangeConfiguration', 'onDidCreateFiles', 'onDidDeleteFiles', 'onDidRenameFiles'] as const;
			const events = Object.fromEntries(eventNames.map(key => [key, vscode.workspace[key]])); for (const key of eventNames) { Object.assign(vscode.workspace, { [key]: () => ({ dispose() {} }) }); }
			const vscodeModule = require('vscode') as typeof vscode; const Disposable = vscodeModule.Disposable; Object.assign(vscodeModule, { Disposable: class { private readonly close: () => void; constructor(close: () => void) { this.close = close; } dispose() { this.close(); } } });
			const messages: Array<{ type: string; conversationId?: string; checkpoints?: Array<{ checkpointId: string }>; reset?: boolean; [key: string]: unknown }> = [];
			let receive!: (message: { type: string; checkpointId?: string }) => Promise<void>; let disposeView!: () => void;
			let historyUpdated: (() => void) | undefined;
			const view = { webview: { html: '', options: {}, onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; }, postMessage: async (message: typeof messages[number]) => { messages.push(message); if (message.type === 'historySnapshot') { historyUpdated?.(); } return true; } }, onDidDispose: (listener: () => void) => { disposeView = listener; return { dispose() {} }; } } as unknown as vscode.WebviewView;
			const provider = new ChatViewProvider(f.context, f.store, {} as LlmClient, {} as ToolRegistry, undefined, undefined, undefined, f.manager);
			try {
				assert.doesNotThrow(() => provider.resolveWebviewView(view)); assert.ok((provider as unknown as { session?: ChatSession }).session);
				assert.deepEqual(messages.find(message => message.type === 'checkpointsLoaded'), { type: 'checkpointsLoaded', conversationId: f.first, reset: true, checkpoints: [] });
				messages.length = 0;
				const history = new Promise<void>(resolve => { historyUpdated = resolve; }); await receive({ type: 'webviewReady' }); await history;
				assert.ok(messages.some(message => message.type === 'loadConversation')); assert.ok(messages.some(message => message.type === 'tasksSnapshot')); assert.ok(messages.some(message => message.type === 'historySnapshot'));
				messages.length = 0; const switched = new Promise<void>(resolve => { historyUpdated = resolve; }); provider.openConversation(f.second); await switched;
				assert.ok(messages.some(message => message.type === 'modeChanged')); assert.ok(messages.some(message => message.type === 'tasksSnapshot' && message.conversationId === f.second));
				assert.deepEqual(messages.find(message => message.type === 'checkpointsLoaded')?.checkpoints, []);
				await receive({ type: 'checkpointCompare', checkpointId: f.checkpoint }); await receive({ type: 'checkpointRestoreWorkspace', checkpointId: f.checkpoint });
				assert.ok(f.errors.some(message => message.includes('comparison failed'))); assert.ok(f.errors.some(message => message.includes('restore failed')));
				assert.equal(await fs.readFile(path.join(f.workspace, 'file.txt'), 'utf8'), 'Keep these workspace files'); assert.equal(await fs.readFile(f.index, 'utf8'), '{ damaged');
				await fs.writeFile(f.index, f.healthy); messages.length = 0; const recovered = new Promise<void>(resolve => { historyUpdated = resolve; }); provider.openConversation(f.first); await recovered;
				assert.equal(messages.find(message => message.type === 'checkpointsLoaded')?.checkpoints?.[0]?.checkpointId, f.checkpoint);
				assert.ok(f.warnings.some(message => message.includes('preserved')));
			} finally { disposeView?.(); Object.assign(prototype, previous); Object.assign(vscode.workspace, events); Object.assign(vscodeModule, { Disposable }); }
		});
	});

	test('text branching remains available without claiming a damaged checkpoint or weakening restore rejection', async () => {
		await fixture(async f => {
			let retained = false;
			const actions = new ConversationActions(f.store, (id, count) => f.manager.list(id).find(checkpoint => checkpoint.turnIndex === count)?.id,
				async (id, branchId) => { retained = true; await f.manager.attachToBranch(id, branchId); }, branchId => f.manager.deleteFor(branchId));
			const branch = await actions.branch(f.first, 0); assert.ok(branch);
			assert.deepEqual(branch.messages, f.store.load(f.first)?.messages); assert.equal(branch.summary.branch?.workspaceState, 'unlinked'); assert.equal(branch.summary.branch?.checkpointId, undefined); assert.equal(retained, false);
			await assert.rejects(f.manager.restore(f.checkpoint, { conversationToo: true }), /unavailable/); assert.equal(await fs.readFile(f.index, 'utf8'), '{ damaged');
		});
	});
});
