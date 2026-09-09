/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { CheckpointManager, CheckpointConversationRewindError, type Checkpoint } from 'son-of-anton-core/checkpoint/CheckpointManager';
import { ChatSession, type ChatMessage } from '../src/chat/ChatPanel';
import { ChatTurnQueue } from '../src/chat/ChatTurnQueue';
import { ConversationStore } from '../src/chat/ConversationStore';
import { ConversationStorage } from '../src/chat/ConversationStorage';
import type { LlmStreamEvent } from 'son-of-anton-core/llm/LlmClient';
import type { AgentEvent } from '../src/chat/agentEvents';

class Memento implements vscode.Memento {
	private values = new Map<string, unknown>();
	keys() { return [...this.values.keys()]; }
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	async update(key: string, value: unknown): Promise<void> { if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); } }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const initialMessages: ChatMessage[] = [{ role: 'user', content: 'Original question', timestamp: 1 }, { role: 'assistant', content: 'Later answer', timestamp: 2 }];

interface Session {
	handleCheckpointRestore(checkpointId: string, conversationToo: boolean): Promise<void>;
	handleSendMessage(message: { text: string }): Promise<void>;
	abortInFlight(): void;
	abortController?: AbortController;
	prepareCheckpointRestore(): (id: string) => void;
	switchConversation(id: string): void;
	postSystemMessage(content: string): void;
	currentConversationId: string;
	conversation: ChatMessage[];
	runViaAgentBridge(owner: object, specialist: string, prompt: string, model: string, mode: string): Promise<string>;
}
function session(store: ConversationStore, manager: CheckpointManager, id: string) {
	const messages: Array<{ type: string; conversationId?: string }> = [];
	const value = Object.assign(Object.create(ChatSession.prototype), {
		currentConversationId: 'unselected', conversation: [], conversationStore: store, checkpointManager: manager,
		currentSpecialistId: 'anton', currentMode: 'act', currentTab: 'chat', currentModel: 'sonnet',
		pendingApprovals: new Map(), emittedUiBlockIds: new Set(), pendingUiBlockResponses: new Set(), followupQueue: new ChatTurnQueue(),
		webview: { postMessage: async (message: typeof messages[number]) => { messages.push(message); return true; } },
		postHistorySnapshot() {}, postBoardSnapshot() {}, postFollowupQueue() {}, postProviderCatalog() {},
		buildUserPrompt: async (text: string) => text, turnsRun: 0, sessionTotalCost: 0, sessionTotalTokens: 0, sessionTurnCount: 0, editedToolResults: new Map(),
	}) as Session;
	value.switchConversation(id); messages.length = 0;
	return { session: value, messages };
}
function nativeSession(value: Session, stream: () => AsyncGenerator<LlmStreamEvent>): void {
	Object.assign(value, {
		agentBridge: undefined,
		llmClient: { getTokenUsage: () => ({ input: 10, output: 5, cached: 0 }), estimateCost: () => 0.01, streamRequest: stream },
		toolRegistry: { definitions: () => [] },
	});
}

async function fixture(kind: 'git' | 'fs', run: (f: {
	store: ConversationStore; other: ConversationStore; disk: ConversationStorage; writer: ConversationStorage;
	manager: CheckpointManager; checkpoint: Checkpoint; id: string; file: string; info: string[]; errors: string[];
	confirm: { run: () => Promise<boolean> }; recovery(): Promise<Checkpoint>;
}) => Promise<void>) {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-durable-rewind-')); const workspace = path.join(directory, 'workspace');
	await fs.mkdir(workspace); const file = path.join(workspace, 'file.txt'); await fs.writeFile(file, 'before');
	const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	if (kind === 'git') { git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('add', '.'); git('commit', '-qm', 'initial'); }
	const context = () => ({ globalState: new Memento(), workspaceState: new Memento(), globalStorageUri: vscode.Uri.file(path.join(directory, 'history')) }) as unknown as vscode.ExtensionContext;
	const firstContext = context(); const store = new ConversationStore(firstContext); const other = new ConversationStore(context());
	const info: string[] = [], errors: string[] = []; const confirm = { run: async () => true };
	const host = { storageRoot: path.join(directory, 'checkpoints'), getWorkspaceRoot: () => workspace, config: { get: <T>(_key: string, fallback?: T) => fallback as T }, confirmRestore: () => confirm.run(), notifier: { info: (message: string) => { info.push(message); }, warn() {}, error: (message: string) => { errors.push(message); } } };
	const manager = new CheckpointManager(store, firstContext.globalState, host);
	const showError = vscode.window.showErrorMessage, warn = console.warn;
	vscode.window.showErrorMessage = (async (message: string) => { errors.push(message); return undefined; }) as typeof vscode.window.showErrorMessage; console.warn = () => {};
	try {
		await Promise.all([store.ready, other.ready]); const record = store.create(initialMessages); await store.flush();
		const checkpoint = await manager.capture(record.summary.id, 1, 'Original question'); assert.ok(checkpoint); await fs.writeFile(file, 'after');
		const disk = new ConversationStorage(path.join(directory, 'history', 'conversations-v2'));
		const writer = (store as unknown as { disk: ConversationStorage }).disk;
		await run({ store, other, disk, writer, manager, checkpoint, id: record.summary.id, file, info, errors, confirm, recovery: async () => {
			const reopened = new CheckpointManager(store, firstContext.globalState, host);
			try {
				const recovery = reopened.list(record.summary.id).find(cp => cp.id !== checkpoint.id); assert.ok(recovery);
				if (recovery.fileSnapshot) {
					const snapshot = recovery.fileSnapshot;
					const location = path.join(snapshot.storageRoot, createHash('sha256').update(snapshot.workspaceRoot).digest('hex'), snapshot.id);
					const manifest = JSON.parse(await fs.readFile(path.join(location, 'manifest.json'), 'utf8')) as { files: Array<{ digest: string }> };
					assert.equal(await fs.readFile(path.join(location, manifest.files[0].digest), 'utf8'), 'after');
				} else { assert.equal(git('show', `${recovery.snapshot!.commit}:file.txt`), 'after'); }
				return recovery;
			} finally { reopened.dispose(); }
		} });
	} finally { manager.dispose(); for (const current of [store, other]) { current.dispose(); await current.flush().catch(() => {}); } vscode.window.showErrorMessage = showError; console.warn = warn; await fs.rm(directory, { recursive: true, force: true }); }
}

suite('Durable checkpoint conversation rewind', () => {
	for (const kind of ['fs', 'git'] as const) {
		test(`${kind} restore waits for its exact history commit without exposing a provisional truncation`, async () => fixture(kind, async f => {
			const entered = deferred(), release = deferred(); const save = f.writer.save.bind(f.writer);
			f.writer.save = async (...args: Parameters<ConversationStorage['save']>) => { if (args[0].summary.id === f.id && args[0].messages.length === 1) { entered.resolve(); await release.promise; } await save(...args); };
			let settled = false; const restoration = f.manager.restore(f.checkpoint.id, { conversationToo: true }).finally(() => { settled = true; });
			try { await entered.promise; assert.deepEqual({ settled, infos: f.info.length, visible: f.store.load(f.id)?.messages, durable: f.disk.load(f.id)?.messages, file: await fs.readFile(f.file, 'utf8') }, { settled: false, infos: 0, visible: initialMessages, durable: initialMessages, file: 'before' }); }
			finally { release.resolve(); await restoration; }
			assert.deepEqual(f.disk.load(f.id)?.messages, initialMessages.slice(0, 1)); assert.equal(f.info.length, 1); await f.recovery();
		}));

		test(`${kind} restore preserves a newer window's transcript and reports the partial outcome on CAS rejection`, async () => fixture(kind, async f => {
			const newer = [...initialMessages, { role: 'user' as const, content: 'Newer window turn', timestamp: 3 }];
			f.confirm.run = async () => { const record = f.other.load(f.id)!; f.other.update(f.id, newer, undefined, undefined, undefined, undefined, record.writeToken); await f.other.flush(); return true; };
			let failure: CheckpointConversationRewindError | undefined;
			await assert.rejects(f.manager.restore(f.checkpoint.id, { conversationToo: true }), error => { assert.ok(error instanceof CheckpointConversationRewindError); failure = error; return true; });
			assert.deepEqual({ file: await fs.readFile(f.file, 'utf8'), visible: f.store.load(f.id)?.messages, durable: f.disk.load(f.id)?.messages, info: f.info }, { file: 'before', visible: newer, durable: newer, info: [] });
			assert.equal(failure?.recoveryCheckpointId, (await f.recovery()).id); assert.match(String(failure?.cause), /newer conversation history/);
			await f.store.flush(); // A failed explicit operation does not poison an otherwise healthy queue.
		}));

		test(`${kind} disk failure keeps the original chat visible and never reloads an unsaved rewind`, async () => fixture(kind, async f => {
			const save = f.writer.save.bind(f.writer); f.writer.save = async (...args: Parameters<ConversationStorage['save']>) => { if (args[0].summary.id === f.id && args[0].messages.length === 1) { throw Object.assign(new Error('History disk is full'), { code: 'ENOSPC' }); } await save(...args); };
			const chat = session(f.store, f.manager, f.id); await chat.session.handleCheckpointRestore(f.checkpoint.id, true);
			assert.deepEqual({ file: await fs.readFile(f.file, 'utf8'), chat: chat.session.conversation, visible: f.store.load(f.id)?.messages, durable: f.disk.load(f.id)?.messages, info: f.info, reloads: chat.messages.filter(message => message.type === 'loadConversation') }, { file: 'before', chat: initialMessages, visible: initialMessages, durable: initialMessages, info: [], reloads: [] });
			assert.ok(f.errors.some(message => message.includes('Workspace files were restored') && message.includes('Recovery checkpoint'))); await f.recovery();
		}));
	}

	test('a rewind succeeds despite an unrelated failed save and a throwing post-commit listener', async () => fixture('fs', async f => {
		const unrelated = f.store.create(); await f.store.flush(); const save = f.writer.save.bind(f.writer);
		f.writer.save = async (...args: Parameters<ConversationStorage['save']>) => { if (args[0].summary.id === unrelated.summary.id) { throw new Error('Unrelated history failure'); } await save(...args); };
		f.store.update(unrelated.summary.id, initialMessages); await assert.rejects(f.store.flush(), /Unrelated/);
		const listener = f.store.onDidChange(() => { throw new Error('Display listener failed'); });
		try { await f.manager.restore(f.checkpoint.id, { conversationToo: true }); }
		finally { listener.dispose(); }
		assert.deepEqual(f.disk.load(f.id)?.messages, initialMessages.slice(0, 1)); assert.equal(f.info.length, 1);
	}));

	test('missing or trashed conversations fail before workspace changes', async () => fixture('fs', async f => {
		f.store.delete(f.id); await f.store.flush();
		await assert.rejects(f.manager.restore(f.checkpoint.id, { conversationToo: true }), /no longer available/);
		assert.equal(await fs.readFile(f.file, 'utf8'), 'after'); assert.equal(f.info.length, 0);
		await assert.rejects(f.store.updateAndWait('missing', []), /no longer available/);
	}));

	test('a committed external deletion during the exact write reports partial restore without resurrection', async () => fixture('fs', async f => {
		const save = f.writer.save.bind(f.writer);
		f.writer.save = async (...args: Parameters<ConversationStorage['save']>) => { await f.disk.delete(f.id); await save(...args); };
		await assert.rejects(f.manager.restore(f.checkpoint.id, { conversationToo: true }), CheckpointConversationRewindError);
		assert.equal(f.disk.load(f.id), undefined); assert.equal(f.store.load(f.id), undefined); assert.equal(f.info.length, 0); assert.equal(await fs.readFile(f.file, 'utf8'), 'before');
	}));

	test('failed rewind preserves an earlier unsaved overlay without replacing its token', async () => fixture('fs', async f => {
		const save = f.writer.save.bind(f.writer); f.writer.save = async () => { throw new Error('Disk full'); };
		const original = f.store.load(f.id)!; const pending = [...initialMessages, { role: 'user' as const, content: 'Unsaved draft', timestamp: 3 }];
		f.store.update(f.id, pending, undefined, undefined, undefined, undefined, original.writeToken); await assert.rejects(f.store.flush(), /Disk full/);
		const before = f.store.load(f.id)!;
		await assert.rejects(f.manager.restore(f.checkpoint.id, { conversationToo: true }), CheckpointConversationRewindError);
		const after = f.store.load(f.id)!; assert.deepEqual(after.messages, pending); assert.equal(after.writeToken?.revision, before.writeToken?.revision); assert.deepEqual(f.disk.load(f.id)?.messages, initialMessages);
		f.writer.save = save;
	}));

	test('a cancelled bridge finalizer cannot append with the rewound session token', async () => fixture('fs', async f => {
		const chat = session(f.store, f.manager, f.id); const entered = deferred(), release = deferred();
		const owner = { controller: new AbortController(), conversationId: f.id, requestId: 'old-request', turnId: 'old-turn', draft: { text: 'Old prompt' } };
		Object.assign(chat.session, { abortController: owner.controller, activeTurn: owner, agentBridge: { runOrchestrator: async (_prompt: string, emit: (event: AgentEvent) => void) => { emit({ type: 'token', token: 'Late partial answer' }); entered.resolve(); await release.promise; } } });
		const running = chat.session.runViaAgentBridge(owner, 'anton', 'Old prompt', 'sonnet', 'act'); await entered.promise;
		try { await chat.session.handleCheckpointRestore(f.checkpoint.id, true); }
		finally { release.resolve(); }
		assert.equal(await running, ''); await f.store.flush();
		assert.deepEqual(chat.session.conversation, initialMessages.slice(0, 1)); assert.deepEqual(f.disk.load(f.id)?.messages, initialMessages.slice(0, 1));
		assert.equal(owner.controller.signal.aborted, true); assert.equal(chat.messages.filter(message => message.type === 'loadConversation').length, 1);
	}));

	test('a restore completing after a conversation switch does not reload a different session', async () => fixture('fs', async f => {
		const other = f.store.create([{ role: 'user', content: 'Other conversation', timestamp: 3 }]); await f.store.flush();
		const chat = session(f.store, f.manager, f.id); f.confirm.run = async () => { chat.session.switchConversation(other.summary.id); chat.messages.length = 0; return true; };
		await chat.session.handleCheckpointRestore(f.checkpoint.id, true);
		assert.equal(chat.session.currentConversationId, other.summary.id); assert.deepEqual(chat.session.conversation, other.messages); assert.equal(chat.messages.filter(message => message.type === 'loadConversation').length, 0); assert.deepEqual(f.disk.load(f.id)?.messages, initialMessages.slice(0, 1));
	}));
	test('declining restore settles the cancelled owner and leaves the session usable', async () => fixture('fs', async f => {
		const chat = session(f.store, f.manager, f.id);
		const owner = { controller: new AbortController(), conversationId: f.id, requestId: 'cancelled-request', turnId: 'cancelled-turn', draft: { text: 'Old prompt' }, checkpointCancelled: false };
		Object.assign(chat.session, { abortController: owner.controller, activeTurn: owner });
		f.confirm.run = async () => false;
		await chat.session.handleCheckpointRestore(f.checkpoint.id, true);
		assert.deepEqual({ file: await fs.readFile(f.file, 'utf8'), durable: f.disk.load(f.id)?.messages, infos: f.info, aborted: owner.controller.signal.aborted, superseded: owner.checkpointCancelled, controller: (chat.session as unknown as { abortController?: AbortController }).abortController }, { file: 'after', durable: initialMessages, infos: [], aborted: true, superseded: true, controller: undefined });
		assert.ok(chat.messages.some(message => message.type === 'requestSettled'));
		chat.session.postSystemMessage('After cancelled restore'); await f.store.flush();
		assert.equal(f.disk.load(f.id)?.messages.at(-1)?.content, 'After cancelled restore');
	}));

	test('a failed exact rewind does not remove a later queued transcript', async () => fixture('fs', async f => {
		const entered = deferred(), release = deferred(); const save = f.writer.save.bind(f.writer);
		f.writer.save = async (...args: Parameters<ConversationStorage['save']>) => { if (args[0].messages.length === 1) { entered.resolve(); await release.promise; throw new Error('Rewind write failed'); } await save(...args); };
		const restoration = assert.rejects(f.manager.restore(f.checkpoint.id, { conversationToo: true }), CheckpointConversationRewindError);
		await entered.promise;
		const record = f.store.load(f.id)!; const later = [...record.messages, { role: 'user' as const, content: 'Later queued turn', timestamp: 3 }];
		f.store.update(f.id, later, undefined, undefined, undefined, undefined, record.writeToken);
		release.resolve(); await restoration; await f.store.flush();
		assert.deepEqual(f.store.load(f.id)?.messages, later); assert.deepEqual(f.disk.load(f.id)?.messages, later);
	}));

	test('a cancelled native finalizer cannot append with the rewound session token', async () => fixture('fs', async f => {
		const chat = session(f.store, f.manager, f.id); const entered = deferred(), release = deferred();
		nativeSession(chat.session, async function* () { yield { type: 'token', token: 'Native partial answer' }; entered.resolve(); await release.promise; yield { type: 'complete', fullText: 'Native partial answer', stopReason: 'end_turn', inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }; });
		const running = chat.session.handleSendMessage({ text: 'A native question' }); await entered.promise; await f.store.flush();
		try { await chat.session.handleCheckpointRestore(f.checkpoint.id, true); }
		finally { release.resolve(); }
		await running; await f.store.flush();
		assert.deepEqual(chat.session.conversation, initialMessages.slice(0, 1)); assert.deepEqual(f.disk.load(f.id)?.messages, initialMessages.slice(0, 1));
	}));

	test('a new turn awaiting context supersedes the pending restore reload without receiving its write token', async () => fixture('fs', async f => {
		const chat = session(f.store, f.manager, f.id); const entered = deferred(), release = deferred(); let running: Promise<void> | undefined;
		nativeSession(chat.session, async function* () { assert.fail('The new turn is cancelled before context completes'); });
		Object.assign(chat.session, { workspaceContext: { collect: async () => { entered.resolve(); await release.promise; return { markdown: 'Captured context', estimatedTokens: 4 }; } } });
		f.confirm.run = async () => { running = chat.session.handleSendMessage({ text: 'New question while confirming' }); await entered.promise; return true; };
		try {
			await chat.session.handleCheckpointRestore(f.checkpoint.id, true);
			assert.equal(f.info.length, 1); assert.deepEqual(f.disk.load(f.id)?.messages, initialMessages.slice(0, 1));
			assert.deepEqual(chat.session.conversation, initialMessages); assert.equal(chat.messages.filter(message => message.type === 'loadConversation').length, 0); assert.equal(chat.session.abortController?.signal.aborted, false);
		} finally { chat.session.abortInFlight(); release.resolve(); await running; }
	}));

});
