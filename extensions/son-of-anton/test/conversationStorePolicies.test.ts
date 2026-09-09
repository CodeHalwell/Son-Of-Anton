/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ConversationStorage } from '../src/chat/ConversationStorage';
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

	test('retains more than 50 conversations without deleting the oldest', () => {
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
			{ count: 51, evictedPresent: true, bodyCleared: false },
		);
		store.dispose();
	});

	test('retains the full transcript beyond 500 messages', () => {
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
			{ count: 501, firstContent: 'message-0', lastContent: 'message-500' },
		);
		store.dispose();
	});

	test('delete() hides a conversation but retains its body for recovery', () => {
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
			{ inList: false, bodyCleared: false, loadResult: undefined },
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

	test('migration clears legacy history only after successful persistence', async () => {
		const { context, workspaceState } = makeContext();
		const legacy: ChatMessage[] = [userMsg('legacy question'), assistantMsg('legacy answer')];
		void workspaceState.update('sota.chatHistory', legacy);

		const store = new ConversationStore(context);
		await store.ready;

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

	test('active-selection and deletion events identify the affected conversation exactly once', () => {
		const { context } = makeContext(); const store = new ConversationStore(context, 'a', 'A');
		const selected: string[] = []; const deleted: string[] = [];
		store.onDidChangeActive(id => selected.push(id));
		store.onDidDelete(id => { assert.equal(store.load(id), undefined); deleted.push(id); });
		try {
			const a = store.create(); const b = store.create();
			store.rememberActive(a.summary.id); store.rememberActive(a.summary.id); store.rememberActive('missing');
			store.delete(b.summary.id); store.delete(b.summary.id);
			assert.deepStrictEqual({ selected, deleted }, { selected: [a.summary.id], deleted: [b.summary.id] });
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
	test('pinning, archive, body search and Trash are independent and recoverable', async () => {
		const { context } = makeContext(); const store = new ConversationStore(context, 'project', 'Project');
		try {
			const first = store.create([userMsg('First'), assistantMsg('deep searchable phrase')]); const second = store.create([userMsg('Second')]);
			store.setPinned(first.summary.id, true); store.archive(first.summary.id);
			assert.deepStrictEqual((await store.searchAsync({ query: 'searchable', scope: 'archived' })).items.map(item => item.id), [first.summary.id]);
			store.delete(first.summary.id); assert.equal(store.search({ scope: 'trash' }).total, 1);
			store.restore(first.summary.id); assert.deepStrictEqual(store.list().map(item => item.id), [first.summary.id, second.summary.id]);
			store.permanentDelete(first.summary.id); assert.ok(store.load(first.summary.id));
			store.delete(first.summary.id); store.permanentDelete(first.summary.id); assert.equal(store.load(first.summary.id, true), undefined);
		} finally { store.dispose(); }
	});

	test('branches copy a bounded transcript and explicitly record their workspace association', () => {
		const { context } = makeContext(); const store = new ConversationStore(context);
		try {
			const source = store.create([userMsg('Question'), assistantMsg('Answer'), userMsg('Later')]);
			const branch = store.branch(source.summary.id, 1, { checkpointId: 'checkpoint', workspaceState: 'checkpoint-available' })!;
			branch.messages[0].content = 'Edited fork';
			assert.deepStrictEqual({ original: store.load(source.summary.id)?.messages[0].content, length: branch.messages.length, relation: branch.summary.branch }, { original: 'Question', length: 2, relation: { parentId: source.summary.id, throughMessageIndex: 1, checkpointId: 'checkpoint', workspaceState: 'checkpoint-available' } });
			assert.equal(store.branch(source.summary.id, 999), undefined);
		} finally { store.dispose(); }
	});

	test('disk history migrates durably, pages messages and remains discoverable across stores', async () => {
		const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-storage-'));
		const { context, globalState } = makeContext(); Object.assign(context, { globalStorageUri: vscode.Uri.file(directory) });
		void globalState.update('sota.conversations.index', [{ id: 'older', title: 'Old', createdAt: 1, updatedAt: 1, messageCount: 1 }]);
		void globalState.update('sota.conversations.older', [userMsg('Legacy body')]);
		const store = new ConversationStore(context, 'workspace', 'Workspace');
		try {
			await store.ready; assert.equal(globalState.get('sota.conversations.index'), undefined);
			const first = store.create(Array.from({ length: 1001 }, (_, index) => userMsg(`message-${index}`))); await store.flush();
			const reopened = new ConversationStore(context, 'workspace', 'Workspace');
			try {
				await reopened.ready;
				assert.deepStrictEqual(reopened.loadMessages(first.summary.id, 99, 3).map(message => message.content), ['message-99', 'message-100', 'message-101']);
				assert.equal(reopened.load('older')?.messages[0].content, 'Legacy body');
				reopened.create([userMsg('Other window')]); await reopened.flush();
				assert.equal(store.search({ query: 'Other window' }).total, 1);
				assert.equal((await store.searchAsync({ query: 'message-1000', limit: 1 })).total, 1);
			} finally { reopened.dispose(); }
		} finally { store.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test('legacy migration derives manifest counts from actual bodies before clearing Memento records', async () => {
		const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-stale-count-'));
		const { context, globalState } = makeContext(); Object.assign(context, { globalStorageUri: vscode.Uri.file(directory) });
		const fixtures = [{ id: 'overcount', oldCount: 500, actualCount: 2 }, { id: 'undercount', oldCount: 1, actualCount: 105 }, { id: 'empty', oldCount: 99, actualCount: 0 }];
		await globalState.update('sota.conversations.index', fixtures.map(fixture => ({ id: fixture.id, title: fixture.id, createdAt: 1, updatedAt: 1, messageCount: fixture.oldCount })));
		for (const fixture of fixtures) { await globalState.update(`sota.conversations.${fixture.id}`, Array.from({ length: fixture.actualCount }, (_, index) => userMsg(`message-${index}`, index))); }
		const store = new ConversationStore(context);
		try {
			await store.ready;
			assert.deepStrictEqual(fixtures.map(fixture => { const record = store.load(fixture.id)!; return { id: record.summary.id, count: record.summary.messageCount, messages: record.messages.length, legacy: globalState.get(`sota.conversations.${fixture.id}`) }; }), fixtures.map(fixture => ({ id: fixture.id, count: fixture.actualCount, messages: fixture.actualCount, legacy: undefined })));
			assert.equal(globalState.get('sota.conversations.index'), undefined);
			assert.deepStrictEqual(store.recoveryIssues, []);
		} finally { store.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test('failed disk migration retains original records and can be retried without duplicate imports', async () => {
		const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-retry-'));
		const { context, globalState } = makeContext(); Object.assign(context, { globalStorageUri: vscode.Uri.file(directory) });
		void globalState.update('sota.conversations.index', [{ id: 'older', title: 'Keep', createdAt: 1, updatedAt: 1, messageCount: 1 }]);
		void globalState.update('sota.conversations.older', [userMsg('Do not lose this')]);
		const save = ConversationStorage.prototype.save;
		ConversationStorage.prototype.save = async () => { throw new Error('simulated disk failure'); };
		const failed = new ConversationStore(context);
		try {
			await assert.rejects(failed.ready, /simulated disk failure/);
			assert.ok(globalState.get('sota.conversations.older'));
			ConversationStorage.prototype.save = save;
			const retry = new ConversationStore(context);
			try { await retry.ready; assert.deepStrictEqual(retry.list().map(summary => summary.id), ['older']); assert.equal(retry.load('older')?.messages[0].content, 'Do not lose this'); }
			finally { retry.dispose(); }
		} finally { ConversationStorage.prototype.save = save; failed.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test('a damaged manifest preserves recovery data and legacy sources while healthy history remains usable', async () => {
		const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-damaged-manifest-'));
		const { context, globalState, workspaceState } = makeContext(); Object.assign(context, { globalStorageUri: vscode.Uri.file(directory) });
		const writer = new ConversationStore(context, 'workspace', 'Workspace'); await writer.ready;
		const healthy = writer.create([userMsg('Healthy conversation')]); const damaged = writer.create([userMsg('Retain this original')]); await writer.flush(); writer.dispose();
		const manifest = path.join(directory, 'conversations-v2', createHash('sha256').update(damaged.summary.id).digest('hex'), 'manifest.json');
		const broken = '{"version":1,"summary":'; await fs.writeFile(manifest, broken);
		await globalState.update('sota.conversations.index', [damaged.summary]); await globalState.update(`sota.conversations.${damaged.summary.id}`, damaged.messages);
		await workspaceState.update('sota.conversations.active', damaged.summary.id);
		const store = new ConversationStore(context, 'workspace', 'Workspace');
		try {
			await store.ready;
			assert.deepStrictEqual({ listed: store.list().map(summary => summary.id), initial: store.getInitialConversation()?.summary.id, notices: store.recoveryIssues.map(issue => issue.path), file: await fs.readFile(manifest, 'utf8'), legacyIndex: globalState.get('sota.conversations.index'), legacyBody: globalState.get(`sota.conversations.${damaged.summary.id}`) }, { listed: [healthy.summary.id], initial: healthy.summary.id, notices: [manifest], file: broken, legacyIndex: [damaged.summary], legacyBody: damaged.messages });
			assert.throws(() => store.load(damaged.summary.id), /integrity check/);
			assert.equal(store.load(healthy.summary.id)?.messages[0].content, 'Healthy conversation');
			const created = store.create([userMsg('Still able to chat')]); await store.flush(); assert.ok(store.load(created.summary.id));
		} finally { store.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test('an unavailable history directory reports recovery information without blocking construction', async () => {
		const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-invalid-directory-'));
		const { context } = makeContext(); Object.assign(context, { globalStorageUri: vscode.Uri.file(directory) });
		const historyPath = path.join(directory, 'conversations-v2'); await fs.writeFile(historyPath, 'Retain this unexpected file');
		const store = new ConversationStore(context);
		try {
			await store.ready;
			assert.deepStrictEqual({ histories: store.list(), issues: store.recoveryIssues.map(issue => issue.path), retained: await fs.readFile(historyPath, 'utf8') }, { histories: [], issues: [historyPath], retained: 'Retain this unexpected file' });
		} finally { store.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

	test('a damaged active message page reports once and cannot block initial history or body search', async () => {
		const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-damaged-page-'));
		const { context, workspaceState } = makeContext(); Object.assign(context, { globalStorageUri: vscode.Uri.file(directory) });
		const writer = new ConversationStore(context, 'workspace', 'Workspace'); await writer.ready;
		const healthy = writer.create([userMsg('Healthy'), assistantMsg('searchable evidence')]); const damaged = writer.create([userMsg('Damaged'), assistantMsg('searchable evidence')]); await writer.flush(); writer.dispose();
		const folder = path.join(directory, 'conversations-v2', createHash('sha256').update(damaged.summary.id).digest('hex'));
		const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')) as { pages: string[] };
		const page = path.join(folder, manifest.pages[0]); await fs.writeFile(page, 'damaged message bytes');
		await workspaceState.update('sota.conversations.active', damaged.summary.id);
		const store = new ConversationStore(context, 'workspace', 'Workspace'); const notices: string[] = []; const listener = store.onDidEncounterRecoveryIssue(issue => notices.push(issue.path));
		try {
			await store.ready;
			assert.deepStrictEqual({ initial: store.getInitialConversation()?.summary.id, matches: (await store.searchAsync({ query: 'searchable evidence' })).items.map(summary => summary.id), notices, retained: await fs.readFile(page, 'utf8') }, { initial: healthy.summary.id, matches: [healthy.summary.id], notices: [page], retained: 'damaged message bytes' });
			assert.throws(() => store.load(damaged.summary.id), /integrity check/); assert.equal(notices.length, 1);
		} finally { listener.dispose(); store.dispose(); await fs.rm(directory, { recursive: true, force: true }); }
	});

});
