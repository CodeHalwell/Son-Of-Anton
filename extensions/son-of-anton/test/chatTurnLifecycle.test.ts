/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { ChatSession, type ChatMessage } from '../src/chat/ChatPanel';
import type { ModelId } from 'son-of-anton-core/llm/LlmClient';
import type { AgentEvent } from '../src/chat/agentEvents';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

interface TestSession {
	setupMessageHandler(): void;
	currentModel: ModelId;
	handleSendMessage(message: { text: string; conversationId?: string; includeWorkspaceContext?: boolean }): Promise<void>;
	switchConversation(id: string): void;
	clearConversation(): void;
	abortInFlight(): void;
	abortController?: AbortController;
	workspaceContext?: { collect(): Promise<{ markdown: string; estimatedTokens: number }> };
	costReporter?: { getTotalCost(): number };
}

function createSession() {
	const messages: Array<{ type: string; [key: string]: unknown }> = [];
	const models = new Map<string, ModelId>();
	let receive: (message: { type: string; conversationId?: string; model?: ModelId }) => Promise<void>;
	const conversations = new Map<string, ChatMessage[]>([['first', []], ['second', []]]);
	const started = new Map<string, ReturnType<typeof deferred>>();
	const releases = new Map<string, ReturnType<typeof deferred>>();
	const emitters = new Map<string, (event: AgentEvent) => void>();
	const store = {
		rememberActive: (_id: string) => {},
		update: (id: string, content: ChatMessage[], _specialist: string, _mode: string, _tab: string, model: ModelId) => { conversations.set(id, [...content]); models.set(id, model); },
		list: () => Array.from(conversations, ([id, content]) => ({ id, title: id, updatedAt: 1, messageCount: content.length })),
		load: (id: string) => ({ summary: { id, lastModel: models.get(id) }, messages: conversations.get(id) ?? [] }),
		create: () => { conversations.set('fresh', []); return { summary: { id: 'fresh' }, messages: [] }; },
	};
	const session = Object.assign(Object.create(ChatSession.prototype), {
		currentConversationId: 'first', conversation: [], currentSpecialistId: 'anton', currentMode: 'act', currentModel: 'sonnet', currentTab: 'chat', turnsRun: 0,
		disposables: [], pendingApprovals: new Map(), emittedUiBlockIds: new Set(), pendingUiBlockResponses: new Set(),
		conversationStore: store, sessionTotalCost: 0, sessionTotalTokens: 0, sessionTurnCount: 0,
		webview: { onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; }, postMessage: (message: typeof messages[number]) => { messages.push(message); return Promise.resolve(true); } },
		llmClient: { getTokenUsage: () => ({ input: 10, output: 5, cached: 0 }), estimateCost: () => 0.01 },
		buildUserPrompt: async (text: string) => text,
		agentBridge: {
			hasAgent: () => true,
			runOrchestrator: async (prompt: string, emit: (event: AgentEvent) => void) => {
				emitters.set(prompt, emit);
				started.get(prompt)?.resolve();
				await releases.get(prompt)?.promise;
			},
		},
	}) as TestSession;
	function send(text: string, extra: { includeWorkspaceContext?: boolean } = {}) {
		const ready = deferred(); const release = deferred();
		started.set(text, ready); releases.set(text, release);
		return { done: session.handleSendMessage({ text, ...extra }), ready: ready.promise, release: release.resolve, emit: (event: AgentEvent) => emitters.get(text)?.(event) };
	}
	session.setupMessageHandler();
	return { session, messages, conversations, models, receive: (message: Parameters<typeof receive>[0]) => receive(message), send };
}

suite('Chat turn ownership', () => {
	test('model selection persists before sending and rejects stale or unsupported selection messages', async () => {
		const fixture = createSession();
		await fixture.receive({ type: 'selectModel', conversationId: 'first', model: 'claude-code-opus' });
		await fixture.receive({ type: 'selectModel', conversationId: 'second', model: 'haiku' });
		await fixture.receive({ type: 'selectModel', conversationId: 'first', model: 'missing-model' as ModelId });
		assert.deepEqual(Array.from(fixture.models), [['first', 'claude-code-opus']]);
		fixture.session.switchConversation('second');
		assert.equal(fixture.session.currentModel, 'sonnet');
		fixture.session.switchConversation('first');
		assert.equal(fixture.session.currentModel, 'claude-code-opus');
		fixture.session.clearConversation();
		assert.equal(fixture.models.get('fresh'), 'claude-code-opus');
	});

	test('completed turn and session meters use the same model-aware cost source', async () => {
		const fixture = createSession();
		let cost = 0;
		fixture.session.costReporter = { getTotalCost: () => cost };
		const request = fixture.send('cost check');
		await request.ready;
		cost = 0.0123;
		request.emit({ type: 'token', token: 'Done' });
		request.release(); await request.done;
		assert.equal(fixture.messages.find(message => message.type === 'messageComplete')?.estimatedCost, '0.0123');
		assert.equal(fixture.messages.find(message => message.type === 'messageMetrics')?.cost, 0.0123);
		assert.equal(fixture.messages.find(message => message.type === 'sessionUsage')?.totalCost, 0.0123);
		assert.equal(fixture.conversations.get('first')?.at(-1)?.specialistId, 'anton');
	});
	test('late events and completion from an old conversation cannot alter the new turn or its cancel handle', async () => {
		const fixture = createSession();
		const first = fixture.send('first request');
		await first.ready;
		fixture.session.switchConversation('second');
		const second = fixture.send('second request');
		await second.ready;
		const activeController = fixture.session.abortController;
		const before = fixture.messages.length;
		first.emit({ type: 'token', token: 'STALE TEXT' });
		first.emit({ type: 'final', text: 'STALE FINAL' });
		first.release(); await first.done;
		assert.equal(fixture.messages.length, before);
		assert.equal(fixture.session.abortController, activeController);
		assert.equal(activeController?.signal.aborted, false);
		second.emit({ type: 'token', token: 'Current response' });
		second.release(); await second.done;
		assert.deepEqual(fixture.conversations.get('second')?.map(message => message.content), ['second request', 'Current response']);
		assert.equal(fixture.messages.filter(message => message.type === 'requestSettled').length, 1);
	});

	test('switching during context collection prevents the old prompt from being persisted or dispatched', async () => {
		const fixture = createSession();
		const pending = deferred();
		fixture.session.workspaceContext = { collect: async () => { await pending.promise; return { markdown: 'old context', estimatedTokens: 3 }; } };
		const request = fixture.session.handleSendMessage({ text: 'first request' });
		fixture.session.switchConversation('second');
		pending.resolve(); await request;
		assert.deepEqual(Array.from(fixture.conversations.values()), [[], []]);
		assert.ok(!fixture.messages.some(message => message.type === 'requestStarted' || message.type === 'streamError'));
	});

	test('cancellation preserves partial output and always settles the composer', async () => {
		const fixture = createSession();
		const request = fixture.send('cancel me');
		await request.ready;
		request.emit({ type: 'token', token: 'Partial response' });
		fixture.session.abortInFlight();
		request.emit({ type: 'token', token: ' ignored after stop' });
		request.release(); await request.done;
		assert.deepEqual(fixture.messages.filter(message => message.type === 'requestSettled'), [{ type: 'requestSettled', cancelled: true }]);
		assert.deepEqual(fixture.conversations.get('first')?.map(message => message.content), ['cancel me', 'Partial response']);
	});

	test('the composer context toggle bypasses automatic collection without blocking the request', async () => {
		const fixture = createSession();
		let collected = 0;
		fixture.session.workspaceContext = { collect: async () => { collected++; return { markdown: 'workspace', estimatedTokens: 3 }; } };
		const request = fixture.send('plain question', { includeWorkspaceContext: false });
		await request.ready;
		request.release(); await request.done;
		assert.equal(collected, 0);
		assert.equal(fixture.conversations.get('first')?.[0]?.content, 'plain question');
	});

	test('context failures end the loading state with a visible error', async () => {
		const fixture = createSession();
		fixture.session.workspaceContext = { collect: async () => { throw new Error('workspace unavailable'); } };
		await fixture.session.handleSendMessage({ text: 'request' });
		assert.deepEqual(fixture.messages, [{ type: 'streamError', error: 'workspace unavailable' }, { type: 'requestSettled', cancelled: false }]);
	});
});
