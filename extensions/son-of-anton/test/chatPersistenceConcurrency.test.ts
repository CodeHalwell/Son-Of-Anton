/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { ChatSession, type ChatMessage } from '../src/chat/ChatPanel';
import { ChatTurnQueue } from '../src/chat/ChatTurnQueue';
import { ConversationStore } from '../src/chat/ConversationStore';
import { ConversationStorage } from '../src/chat/ConversationStorage';

class Memento implements vscode.Memento {
	private readonly values = new Map<string, object>();
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	keys(): string[] { return [...this.values.keys()]; }
	async update(key: string, value: object | undefined): Promise<void> { if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); } }
}

interface Session {
	switchConversation(id: string): void;
	postSystemMessage(content: string): void;
	clearConversation(): void;
	reloadCurrentConversation(): void;
	currentConversationId: string;
	conversation: ChatMessage[];
}

/** Exercise production transcript loading and persistence without starting a provider or webview timer. */
function session(store: ConversationStore, id: string): Session {
	const value = Object.assign(Object.create(ChatSession.prototype), {
		currentConversationId: 'unselected', conversation: [], conversationStore: store,
		currentSpecialistId: 'anton', currentMode: 'act', currentTab: 'chat', currentModel: 'sonnet',
		pendingApprovals: new Map(), emittedUiBlockIds: new Set(), pendingUiBlockResponses: new Set(), followupQueue: new ChatTurnQueue(),
		webview: { postMessage: async () => true }, postHistorySnapshot() {}, postBoardSnapshot() {}, postFollowupQueue() {},
	}) as Session;
	value.switchConversation(id);
	return value;
}

async function fixture(sharedStore: boolean, run: (first: ConversationStore, second: ConversationStore, disk: ConversationStorage) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-chat-write-lineage-'));
	const context = () => ({ globalState: new Memento(), workspaceState: new Memento(), globalStorageUri: vscode.Uri.file(directory) }) as unknown as vscode.ExtensionContext;
	const first = new ConversationStore(context());
	const second = sharedStore ? first : new ConversationStore(context());
	try { await Promise.all([first.ready, second.ready]); await run(first, second, new ConversationStorage(path.join(directory, 'conversations-v2'))); }
	finally { for (const store of new Set([first, second])) { store.dispose(); await store.flush().catch(() => {}); } await fs.rm(directory, { recursive: true, force: true }); }
}

suite('Chat transcript write ownership', () => {
	for (const sharedStore of [false, true]) {
		test(`${sharedStore ? 'sidebar and editor' : 'separate windows'} keep stale chat saves from removing another session's turns`, async () => {
			await fixture(sharedStore, async (first, second, disk) => {
				const record = first.create([{ role: 'user', content: 'Original question', timestamp: 1 }]); await first.flush();
				const id = record.summary.id; const winner = session(first, id); const stale = session(second, id);
				winner.postSystemMessage('Newer saved turn'); await first.flush();
				// These unrelated reads must not replace the stale session's own write lineage.
				second.list(); second.load(id); second.loadMessage(id, 0);
				stale.postSystemMessage('Unsaved local turn');
				await assert.rejects(second.flush(), /another window|conflict|changed/i);
				assert.deepEqual(disk.load(id)?.messages.map(message => message.content), ['Original question', 'Newer saved turn']);
				assert.deepEqual(stale.conversation.map(message => message.content), ['Original question', 'Unsaved local turn']);
				winner.postSystemMessage('Another valid turn'); await first.flush();
				assert.deepEqual(disk.load(id)?.messages.map(message => message.content), ['Original question', 'Newer saved turn', 'Another valid turn']);
			});
		});
	}

	test('sessions opened on an unflushed new conversation do not share future write authority', async () => {
		await fixture(true, async (store, _second, disk) => {
			const record = store.create([{ role: 'user', content: 'Pending initial question', timestamp: 1 }]);
			const winner = session(store, record.summary.id); const stale = session(store, record.summary.id);
			await store.flush(); winner.postSystemMessage('First saved answer'); await store.flush();
			stale.postSystemMessage('Competing answer'); await assert.rejects(store.flush(), /another window|conflict|changed/i);
			assert.deepEqual(disk.load(record.summary.id)?.messages.map(message => message.content), ['Pending initial question', 'First saved answer']);
		});
	});

	test('a session can queue saves, reload its saved transcript and start a new conversation', async () => {
		await fixture(true, async (store, _second, disk) => {
			const record = store.create(); await store.flush(); const current = session(store, record.summary.id);
			current.postSystemMessage('Queued one'); current.postSystemMessage('Queued two'); await store.flush();
			current.reloadCurrentConversation(); current.postSystemMessage('After reload'); await store.flush();
			assert.deepEqual(disk.load(record.summary.id)?.messages.map(message => message.content), ['Queued one', 'Queued two', 'After reload']);
			current.clearConversation(); current.postSystemMessage('Fresh conversation'); await store.flush();
			assert.notEqual(current.currentConversationId, record.summary.id);
			assert.deepEqual(disk.load(current.currentConversationId)?.messages.map(message => message.content), ['Fresh conversation']);
		});
	});
});
