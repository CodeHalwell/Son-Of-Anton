/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConversationStore } from '../src/chat/ConversationStore';
import type { ChatMessage } from '../src/chat/ChatPanel';

// ── Fake VS Code ExtensionContext with in-memory Memento ──────────────────────

class FakeMemento implements vscode.Memento {
	private readonly data = new Map<string, unknown>();

	keys(): readonly string[] {
		return Array.from(this.data.keys());
	}

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return (this.data.has(key) ? this.data.get(key) : defaultValue) as T | undefined;
	}

	update(key: string, value: unknown): Thenable<void> {
		if (value === undefined) {
			this.data.delete(key);
		} else {
			this.data.set(key, value);
		}
		return Promise.resolve();
	}

	setKeysForSync(_keys: readonly string[]): void {
		// no-op
	}
}

function makeContext(sharedGlobalState?: FakeMemento): {
	context: vscode.ExtensionContext;
	globalState: FakeMemento;
	workspaceState: FakeMemento;
} {
	const globalState = sharedGlobalState ?? new FakeMemento();
	const workspaceState = new FakeMemento();
	const context = {
		globalState,
		workspaceState,
	} as unknown as vscode.ExtensionContext;
	return { context, globalState, workspaceState };
}

function userMsg(content: string, ts = Date.now()): ChatMessage {
	return { role: 'user', content, timestamp: ts };
}

function assistantMsg(content: string, ts = Date.now()): ChatMessage {
	return { role: 'assistant', content, timestamp: ts };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('ConversationStore — Phase 47', () => {

	test('create() returns a record with a fresh id and placeholder title', () => {
		const { context } = makeContext();
		const store = new ConversationStore(context);
		const record = store.create();

		assert.deepStrictEqual(
			{
				hasId: typeof record.summary.id === 'string' && record.summary.id.length > 0,
				title: record.summary.title,
				messageCount: record.summary.messageCount,
				isUuidShape: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.summary.id),
			},
			{ hasId: true, title: 'New conversation', messageCount: 0, isUuidShape: true },
		);
		store.dispose();
	});

	test('update() derives a title from the first user message', () => {
		const { context } = makeContext();
		const store = new ConversationStore(context);
		const record = store.create();

		store.update(record.summary.id, [userMsg('How do I configure ESLint?'), assistantMsg('You configure...')]);

		const reloaded = store.load(record.summary.id);
		assert.strictEqual(reloaded?.summary.title, 'How do I configure ESLint?');
		store.dispose();
	});

	test('update() persists lastMode and round-trips it across loads', () => {
		const { context } = makeContext();
		const store = new ConversationStore(context);
		const record = store.create();

		store.update(record.summary.id, [userMsg('design first')], 'anton', 'plan');

		const reloaded = store.load(record.summary.id);
		assert.deepStrictEqual(
			{
				lastMode: reloaded?.summary.lastMode,
				lastSpecialist: reloaded?.summary.lastSpecialist,
			},
			{ lastMode: 'plan', lastSpecialist: 'anton' },
		);
		store.dispose();
	});

	test('list() returns conversations newest-first by updatedAt', async () => {
		const { context } = makeContext();
		const store = new ConversationStore(context);
		const a = store.create();
		await new Promise(r => setTimeout(r, 5));
		const b = store.create();
		await new Promise(r => setTimeout(r, 5));
		const c = store.create();

		const ids = store.list().map(s => s.id);
		assert.deepStrictEqual(ids, [c.summary.id, b.summary.id, a.summary.id]);
		store.dispose();
	});

	test('caps at 50 conversations — creating 51 evicts the oldest', () => {
		const { context, globalState } = makeContext();
		const store = new ConversationStore(context);

		const first = store.create();
		// Backdate so it has the lowest updatedAt and gets pruned first.
		const index = (globalState.get<Array<{ id: string; updatedAt: number; createdAt: number }>>(
			'sota.conversations.index',
		) ?? []).map(s => (s.id === first.summary.id ? { ...s, updatedAt: 1, createdAt: 1 } : s));
		void globalState.update('sota.conversations.index', index);

		for (let i = 0; i < 50; i++) {
			store.create();
		}

		const list = store.list();
		const evictedRecord = globalState.get<unknown>(`sota.conversations.${first.summary.id}`);
		assert.deepStrictEqual(
			{ count: list.length, evictedPresent: list.some(s => s.id === first.summary.id), bodyCleared: evictedRecord === undefined },
			{ count: 50, evictedPresent: false, bodyCleared: true },
		);
		store.dispose();
	});

	test('caps at 500 messages per conversation — pushing 501 drops the oldest', () => {
		const { context } = makeContext();
		const store = new ConversationStore(context);
		const record = store.create();

		const messages: ChatMessage[] = [];
		for (let i = 0; i < 501; i++) {
			messages.push(userMsg(`message-${i}`, Date.now() + i));
		}
		store.update(record.summary.id, messages);

		const reloaded = store.load(record.summary.id);
		assert.deepStrictEqual(
			{
				count: reloaded?.messages.length,
				firstContent: reloaded?.messages[0]?.content,
				lastContent: reloaded?.messages[reloaded.messages.length - 1]?.content,
			},
			{ count: 500, firstContent: 'message-1', lastContent: 'message-500' },
		);
		store.dispose();
	});

	test('delete() removes the summary AND the per-conversation message body', () => {
		const { context, globalState } = makeContext();
		const store = new ConversationStore(context);
		const record = store.create();
		store.update(record.summary.id, [userMsg('hi')]);

		store.delete(record.summary.id);

		assert.deepStrictEqual(
			{
				inList: store.list().some(s => s.id === record.summary.id),
				bodyCleared: globalState.get<unknown>(`sota.conversations.${record.summary.id}`) === undefined,
				loadResult: store.load(record.summary.id),
			},
			{ inList: false, bodyCleared: true, loadResult: undefined },
		);
		store.dispose();
	});

	test('rename() updates the summary title and refreshes updatedAt', async () => {
		const { context } = makeContext();
		const store = new ConversationStore(context);
		const record = store.create();
		const beforeTs = record.summary.updatedAt;
		await new Promise(r => setTimeout(r, 5));

		store.rename(record.summary.id, '  Custom Title  ');

		const summary = store.list().find(s => s.id === record.summary.id);
		assert.deepStrictEqual(
			{ title: summary?.title, updated: (summary?.updatedAt ?? 0) > beforeTs },
			{ title: 'Custom Title', updated: true },
		);
		store.dispose();
	});

	test('migration imports the legacy CONVERSATION_STORAGE_KEY on first construction and clears it', () => {
		const { context, workspaceState } = makeContext();
		const legacy: ChatMessage[] = [userMsg('legacy question'), assistantMsg('legacy answer')];
		void workspaceState.update('sota.chatHistory', legacy);

		const store = new ConversationStore(context);

		const list = store.list();
		assert.deepStrictEqual(
			{
				count: list.length,
				title: list[0]?.title,
				legacyCleared: workspaceState.get<unknown>('sota.chatHistory') === undefined,
				migrationFlag: workspaceState.get<boolean>('sota.conversations.migrated'),
			},
			{ count: 1, title: 'legacy question', legacyCleared: true, migrationFlag: true },
		);
		store.dispose();
	});

	test('migration runs at most once — re-instantiating with the flag set is a no-op', () => {
		const { context, workspaceState } = makeContext();
		void workspaceState.update('sota.chatHistory', [userMsg('would-be reimport')]);
		void workspaceState.update('sota.conversations.migrated', true);

		const store = new ConversationStore(context);

		assert.strictEqual(store.list().length, 0);
		store.dispose();
	});

	test('restores each workspace’s selected chat even when another conversation is newer', () => {
		const a = makeContext();
		const b = makeContext(a.globalState);
		const storeA = new ConversationStore(a.context, 'file:///workspace-a', 'Project A');
		const storeB = new ConversationStore(b.context, 'file:///workspace-b', 'Project B');
		try {
			const selected = storeA.create([userMsg('A selected')]);
			storeA.rememberActive(selected.summary.id);
			storeA.create([userMsg('A newer')]);
			const other = storeB.create([userMsg('B newest')]);
			const reopened = new ConversationStore(a.context, 'file:///workspace-a', 'Project A');
			try {
				assert.deepStrictEqual({
					activeA: reopened.getInitialConversation()?.summary.id,
					activeB: storeB.getInitialConversation()?.summary.id,
					historyCount: reopened.list().length,
					workspace: reopened.getInitialConversation()?.summary.workspaceName,
				}, { activeA: selected.summary.id, activeB: other.summary.id, historyCount: 3, workspace: 'Project A' });
				storeA.delete(selected.summary.id);
				assert.strictEqual(reopened.getInitialConversation()?.summary.title, 'A newer');
			} finally { reopened.dispose(); }
		} finally { storeA.dispose(); storeB.dispose(); }
	});

	test('keeps older unscoped history available without restoring it in an unrelated workspace', () => {
		const { context, globalState } = makeContext();
		void globalState.update('sota.conversations.index', [{ id: 'older', title: 'Earlier work', updatedAt: 1, createdAt: 1, messageCount: 1 }]);
		void globalState.update('sota.conversations.older', [userMsg('original message')]);
		const store = new ConversationStore(context, 'file:///new-project', 'New Project');
		try {
			assert.deepStrictEqual({ initial: store.getInitialConversation(), retained: store.load('older')?.messages[0]?.content }, { initial: undefined, retained: 'original message' });
		} finally { store.dispose(); }
	});

	test('an explicitly opened older conversation becomes active only in the workspace that selected it', () => {
		const a = makeContext();
		const b = makeContext(a.globalState);
		void a.globalState.update('sota.conversations.index', [{ id: 'older', title: 'Earlier work', updatedAt: 1, createdAt: 1, messageCount: 1 }]);
		void a.globalState.update('sota.conversations.older', [userMsg('original message')]);
		const storeA = new ConversationStore(a.context, 'a', 'A');
		const storeB = new ConversationStore(b.context, 'b', 'B');
		try {
			storeA.create([userMsg('A newer')]);
			storeA.rememberActive('older');
			storeA.rememberActive('nonexistent');
			assert.deepStrictEqual({ activeA: storeA.getInitialConversation()?.summary.id, activeB: storeB.getInitialConversation() }, { activeA: 'older', activeB: undefined });
			const reopened = new ConversationStore(a.context, 'a', 'A');
			try { assert.strictEqual(reopened.getInitialConversation()?.summary.id, 'older'); }
			finally { reopened.dispose(); }
		} finally { storeA.dispose(); storeB.dispose(); }
	});

	test('migrates legacy history independently for each workspace, despite an older global flag', () => {
		const a = makeContext();
		const b = makeContext(a.globalState);
		void a.globalState.update('sota.conversations.migrated', true);
		void a.workspaceState.update('sota.chatHistory', [userMsg('Legacy A')]);
		void b.workspaceState.update('sota.chatHistory', [userMsg('Legacy B')]);
		const storeA = new ConversationStore(a.context, 'a', 'A');
		const storeB = new ConversationStore(b.context, 'b', 'B');
		try {
			assert.deepStrictEqual([storeA.getInitialConversation()?.summary.title, storeB.getInitialConversation()?.summary.title, storeA.list().length], ['Legacy A', 'Legacy B', 2]);
		} finally { storeA.dispose(); storeB.dispose(); }
	});

	test('retains model and workspace metadata through message updates and renames', () => {
		const { context } = makeContext();
		const store = new ConversationStore(context, 'a', 'A');
		try {
			const record = store.create();
			store.update(record.summary.id, [], 'anton-code', 'plan', 'roster', 'claude-code-opus');
			store.update(record.summary.id, [userMsg('Keep my provider')]);
			store.rename(record.summary.id, 'Renamed');
			const summary = store.load(record.summary.id)?.summary;
			assert.deepStrictEqual({ model: summary?.lastModel, workspace: summary?.workspaceId, name: summary?.workspaceName, mode: summary?.lastMode, tab: summary?.lastTab }, { model: 'claude-code-opus', workspace: 'a', name: 'A', mode: 'plan', tab: 'roster' });
		} finally { store.dispose(); }
	});

	test('onDidChange fires for create / update / rename / delete', () => {
		const { context } = makeContext();
		const store = new ConversationStore(context);

		let count = 0;
		store.onDidChange(() => { count += 1; });

		const r = store.create();
		store.update(r.summary.id, [userMsg('hi')]);
		store.rename(r.summary.id, 'Renamed');
		store.delete(r.summary.id);

		assert.strictEqual(count, 4);
		store.dispose();
	});
});
