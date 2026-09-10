/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { ChatSession } from '../src/chat/ChatPanel';
import type { ConversationStore } from '../src/chat/ConversationStore';

type SearchResult = Awaited<ReturnType<ConversationStore['searchAsync']>>;
interface HistorySession {
	historyFilter: { query: string; scope: 'active' | 'archived' | 'trash'; workspaceOnly: boolean };
	postHistorySnapshot(offset?: number): Promise<void>;
	dispose(): void;
}

function fixture(readSummary = async (_id: string, _signal: AbortSignal) => ({ title: 'The active conversation' })) {
	const posted: Array<{ activeTitle: string; query: string; historyScope: string; total: number; append: boolean; conversations: Array<{ inCurrentWorkspace: boolean }> }> = [];
	const pending: Array<{ query?: string; signal: AbortSignal; resolve: (result: SearchResult) => void; reject: (error: Error) => void }> = [];
	const session = Object.assign(Object.create(ChatSession.prototype), {
		historyFilter: { query: 'first', scope: 'active', workspaceOnly: false },
		currentConversationId: 'conversation', disposables: [], pendingApprovals: new Map(), followupQueue: { clear() {} },
		conversationStore: {
			getSummaryAsync: readSummary,
			load() { throw new Error('History must not load the active transcript'); },
			search() { throw new Error('History must not load transcripts synchronously'); },
			listForWorkspace() { throw new Error('History must not reload all manifests to decorate a result'); },
			searchAsync: (options: { query?: string }, signal: AbortSignal) => new Promise<SearchResult>((resolve, reject) => pending.push({ query: options.query, signal, resolve, reject })),
			isInCurrentWorkspace: () => true,
		},
		webview: { postMessage: (message: typeof posted[number]) => { posted.push(message); return Promise.resolve(true); } },
	}) as HistorySession;
	return { session, posted, pending };
}

suite('History search lifecycle', () => {
	test('cancels an obsolete search and never renders it over the latest filter', async () => {
		const { session, pending, posted } = fixture();
		const first = session.postHistorySnapshot();
		session.historyFilter = { query: 'latest', scope: 'archived', workspaceOnly: true };
		const latest = session.postHistorySnapshot(50);
		pending[1].resolve({ items: [{ id: 'archived', title: 'Latest match', createdAt: 1, updatedAt: 1, messageCount: 2, archived: true, workspaceId: 'workspace' }], total: 3 }); await latest;
		pending[0].resolve({ items: [], total: 99 }); await first;
		assert.deepStrictEqual({ cancelled: pending.map(request => request.signal.aborted), results: posted.map(({ query, historyScope, total, append }) => ({ query, historyScope, total, append })) }, { cancelled: [true, false], results: [{ query: 'latest', historyScope: 'archived', total: 3, append: true }] });
		assert.equal(posted[0].conversations[0].inCurrentWorkspace, true);
		assert.equal(posted[0].activeTitle, 'The active conversation');
		session.dispose();
	});

	test('disposal aborts storage work and prevents a late history response', async () => {
		const { session, pending, posted } = fixture();
		const search = session.postHistorySnapshot();
		session.dispose(); pending[0].resolve({ items: [], total: 2 }); await search;
		assert.deepStrictEqual({ cancelled: pending[0].signal.aborted, posted }, { cancelled: true, posted: [] });
	});

	test('a superseded active-title lookup cannot overwrite the latest history snapshot', async () => {
		const summaries: Array<{ signal: AbortSignal; resolve: (value: { title: string }) => void }> = [];
		const { session, pending, posted } = fixture((_id, signal) => new Promise(resolve => summaries.push({ signal, resolve })));
		const first = session.postHistorySnapshot();
		pending[0].resolve({ items: [], total: 99 }); await Promise.resolve();
		const latest = session.postHistorySnapshot();
		pending[1].resolve({ items: [], total: 0 }); await Promise.resolve();
		summaries[1].resolve({ title: 'Current title' }); await latest;
		summaries[0].resolve({ title: 'Obsolete title' }); await first;
		assert.deepStrictEqual({ cancelled: summaries.map(request => request.signal.aborted), results: posted.map(({ activeTitle, total }) => ({ activeTitle, total })) }, { cancelled: [true, false], results: [{ activeTitle: 'Current title', total: 0 }] });
		session.dispose();
	});

	test('handles a cancelled search rejection and lets its replacement finish', async () => {
		const { session, pending, posted } = fixture();
		const first = session.postHistorySnapshot(); const second = session.postHistorySnapshot();
		pending[0].reject(new Error('Aborted')); await first;
		pending[1].resolve({ items: [], total: 1 }); await second;
		assert.deepStrictEqual(posted.map(result => result.total), [1]);
		session.dispose();
	});
});
