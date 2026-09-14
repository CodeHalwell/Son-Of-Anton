/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { TaskBoardPanel, type ChatStreamEvent, type TaskBoardPanelHandlers } from '../src/board/TaskBoardPanel';
import { TaskBoardSidebarView } from '../src/board/TaskBoardSidebarView';
import type { TaskBoardModel } from '../src/board/TaskBoardModel';
import type { ConversationStore } from '../src/chat/ConversationStore';

suite('Board conversation lifecycle', () => {
	function fixture() {
		const messages: Array<{ type: string; requestId?: string; event?: ChatStreamEvent }> = [];
		const callbacks: Array<(event: ChatStreamEvent) => void> = [];
		const dispatched: string[] = [];
		let cancelled = 0;
		const handlers: TaskBoardPanelHandlers = {
			dispatchSubtask: id => dispatched.push(id),
			streamChat: (_model, _messages, emit) => { callbacks.push(emit); return { dispose: () => { cancelled++; } }; },
		};
		const panel = Object.assign(Object.create(TaskBoardPanel.prototype), {
			currentConversationId: 'first', closed: false, activeChatStreams: new Map(), pendingReruns: new Set(),
			panel: { webview: { postMessage: (message: typeof messages[number]) => { messages.push(message); } } },
			model: { getSnapshot: () => undefined }, conversationStore: { list: () => [] }, handlers,
		}) as {
			handleMessage(message: object): void;
			switchConversation(id: string | undefined): void;
			activeChatStreams: Map<string, vscode.Disposable>;
		};
		const start = (requestId: string, conversationId = 'first') => panel.handleMessage({ type: 'chat-runtime', requestId, conversationId, model: 'sonnet', messages: [{ role: 'user', content: 'Review the board' }] });
		return { panel, messages, callbacks, handlers, start, dispatched, cancellations: () => cancelled };
	}

	test('switching boards cancels the previous request and suppresses all late chunks', () => {
		const f = fixture(); f.start('old'); f.panel.switchConversation('second');
		const before = f.messages.length;
		f.callbacks[0]({ type: 'tool-call', id: 'tool', name: 'addCard', input: { instruction: 'Stale task' } });
		f.callbacks[0]({ type: 'complete', fullText: 'Stale result' });
		assert.deepEqual({ cancellations: f.cancellations(), requests: f.panel.activeChatStreams.size, lateChunks: f.messages.length - before }, { cancellations: 1, requests: 0, lateChunks: 0 });
		f.start('new', 'second'); f.callbacks[1]({ type: 'token', token: 'Current response' });
		assert.equal(f.messages.at(-1)?.requestId, 'new');
	});

	test('late completion of a replaced request cannot dispose its replacement', () => {
		const f = fixture(); f.start('same'); f.start('same');
		f.callbacks[0]({ type: 'complete', fullText: 'Old request' });
		assert.equal(f.panel.activeChatStreams.size, 1);
		f.callbacks[1]({ type: 'complete', fullText: 'New request' });
		assert.deepEqual({ cancellations: f.cancellations(), requests: f.panel.activeChatStreams.size, completions: f.messages.filter(message => message.event?.type === 'complete').length }, { cancellations: 2, requests: 0, completions: 1 });
	});

	test('queued board actions and chat requests cannot target a newly selected conversation', () => {
		const f = fixture(); f.panel.switchConversation('second');
		f.panel.handleMessage({ type: 'dispatch', conversationId: 'first', taskId: 'shared-id' });
		f.start('stale', 'first');
		f.panel.handleMessage({ type: 'dispatch', conversationId: 'second', taskId: 'current-id' });
		assert.deepEqual({ dispatched: f.dispatched, requests: f.callbacks.length }, { dispatched: ['current-id'], requests: 0 });
	});

	test('synchronous completion and provider startup errors release their request entries', () => {
		const f = fixture(); let released = 0;
		Object.assign(f.handlers, { streamChat: (_model: string, _messages: object, emit: (event: ChatStreamEvent) => void) => { emit({ type: 'complete', fullText: 'Ready' }); return { dispose: () => { released++; } }; } });
		f.start('sync');
		Object.assign(f.handlers, { streamChat: () => { throw new Error('Provider unavailable'); } });
		f.start('error');
		assert.deepEqual({ released, requests: f.panel.activeChatStreams.size, final: f.messages.at(-1)?.event }, { released: 1, requests: 0, final: { type: 'error', error: 'Provider unavailable' } });
	});

	test('sidebar follows active selection and shows an empty board instead of unrelated progress', () => {
		const activeChanged = new vscode.EventEmitter<string>();
		const changed = new vscode.EventEmitter<void>();
		const boardChanged = new vscode.EventEmitter<void>();
		let active = 'empty';
		const messages: Array<{ conversationId: string; total: number }> = [];
		const store = {
			getInitialConversation: () => ({ summary: { id: active, title: active } }),
			list: () => [{ id: 'busy', title: 'Other project' }, { id: 'empty', title: 'Current project' }],
			onDidChange: changed.event, onDidChangeActive: activeChanged.event,
		} as unknown as ConversationStore;
		const model = { onDidChangeBoard: boardChanged.event, getSnapshot: (id: string) => id === 'busy' ? { tasks: [{ state: 'done' }] } : undefined } as unknown as TaskBoardModel;
		const view = Object.assign(new TaskBoardSidebarView({} as vscode.ExtensionContext, model, store), { view: { webview: { postMessage: (message: typeof messages[number]) => messages.push(message) } } });
		try {
			activeChanged.fire('empty'); active = 'busy'; activeChanged.fire('busy'); active = 'empty'; activeChanged.fire('empty');
			assert.deepEqual(messages.map(message => [message.conversationId, message.total]), [['empty', 0], ['busy', 1], ['empty', 0]]);
		} finally { (view as vscode.Disposable).dispose(); activeChanged.dispose(); changed.dispose(); boardChanged.dispose(); }
	});
});
