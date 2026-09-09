/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ChatTurnQueue } from '../src/chat/ChatTurnQueue';
import { ChatSession, type ChatMessage } from '../src/chat/ChatPanel';
import { LlmClient, type LlmStreamEvent, type ModelId, type ToolDefinition } from 'son-of-anton-core/llm/LlmClient';
import { discoveredModelId, getDiscoveredModel, registerDiscoveredModels, type CapabilityAvailability } from 'son-of-anton-core/llm/DiscoveredModels';
import type { AgentEvent } from '../src/chat/agentEvents';
import { AgentBridge } from '../src/chat/AgentBridge';
import { OrchestratorAgent } from 'son-of-anton-core/agents/OrchestratorAgent';
import { AgentManager } from 'son-of-anton-core/agents/AgentManager';
import { MetricsTracker } from 'son-of-anton-core/agents/MetricsTracker';
import { ProjectMemory } from 'son-of-anton-core/agents/ProjectMemory';
import type { AgentStack } from 'son-of-anton-core/agents/AgentStackFactory';
import type { ConversationStore } from '../src/chat/ConversationStore';
import { registerResponseFeedback } from '../src/chat/ResponseFeedback';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

interface TestSession {
	setupMessageHandler(): void;
	currentModel: ModelId;
	currentSpecialistId: string;
	currentMode: string;
	handleConversationDeleted(id: string): void;
	handleSendMessage(message: { text: string; conversationId?: string; includeWorkspaceContext?: boolean; mentionsKinded?: NonNullable<ChatMessage['request']>['mentionsKinded']; attachments?: string[]; model?: ModelId; chatMode?: 'plan' | 'act'; images?: Array<{ mime: string; base64: string }> }): Promise<void>;
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
	let receive: (message: { type: string; conversationId?: string; model?: ModelId; id?: string; specialistId?: string; chatMode?: string }) => Promise<void>;
	const conversations = new Map<string, ChatMessage[]>([['first', []], ['second', []]]);
	const started = new Map<string, ReturnType<typeof deferred>>();
	const releases = new Map<string, ReturnType<typeof deferred>>();
	const emitters = new Map<string, (event: AgentEvent) => void>();
	const store = {
		rememberActive: (_id: string) => {},
		update: (id: string, content: ChatMessage[], _specialist: string, _mode: string, _tab: string, model: ModelId) => { conversations.set(id, [...content]); models.set(id, model); },
		list: () => Array.from(conversations, ([id, content]) => ({ id, title: id, updatedAt: 1, messageCount: content.length })),
		listForWorkspace() { return this.list(); },
		isInCurrentWorkspace: () => true,
		search() { return { items: this.list(), total: conversations.size }; },
		async searchAsync() { return this.search(); },
		getInitialConversation: () => { const id = conversations.keys().next().value; return id ? { summary: { id }, messages: conversations.get(id) ?? [] } : undefined; },
		load: (id: string) => conversations.has(id) ? ({ summary: { id, lastModel: models.get(id) }, messages: conversations.get(id) ?? [] }) : undefined,
		create: () => { conversations.set('fresh', []); return { summary: { id: 'fresh' }, messages: [] }; },
	};
	const session = Object.assign(Object.create(ChatSession.prototype), {
		currentConversationId: 'first', conversation: [], currentSpecialistId: 'anton', currentMode: 'act', currentModel: 'sonnet', currentTab: 'chat', turnsRun: 0,
		postProviderCatalog() {}, postFollowupQueue() {}, followupQueue: new ChatTurnQueue(), contextPreviewSequence: 0, historyFilter: { query: '', scope: 'active', workspaceOnly: false },
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
	return { session, messages, conversations, models, store, receive: (message: Parameters<typeof receive>[0]) => receive(message), send };
}

function realOrchestratorBridge(run: (emit?: (text: string) => void) => Promise<void>) {
	const manager = new AgentManager(null as never);
	const orchestrator = new OrchestratorAgent({ handle: 'anton', displayName: 'Anton', description: 'Test', defaultModel: 'sonnet', maxRetries: 1, slashCommands: [] }, null as never, null as never, manager, new MetricsTracker(), new ProjectMemory());
	Object.assign(orchestrator, { appendQuote() {}, gatherGraphContext: async () => '', callLlm: async (_task: string, _model: string, _system: string, _prompt: string, emit?: (text: string) => void) => { await run(emit); return { text: '', tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0 } }; } });
	const bridge = new AgentBridge({ orchestrator, specialists: new Map() } as unknown as AgentStack);
	const events: AgentEvent[] = []; bridge.onDidEmitEvent(({ event }) => events.push(event));
	return { bridge, events };
}

async function withNativeSession(
	limits: Record<string, number>,
	stream: (signal: AbortSignal) => AsyncGenerator<LlmStreamEvent>,
	run: (fixture: ReturnType<typeof createSession> & { requests: AbortSignal[]; executed: string[]; pendingApprovals: Map<string, object> }) => Promise<void>,
): Promise<void> {
	const originalConfiguration = vscode.workspace.getConfiguration;
	Object.assign(vscode.workspace, { getConfiguration: () => ({ get: (key: string, fallback: object) => limits[key] ?? fallback }) });
	const fixture = createSession(); const requests: AbortSignal[] = []; const executed: string[] = []; const pendingApprovals = new Map<string, object>();
	Object.assign(fixture.session, {
		agentBridge: undefined, pendingApprovals, editedToolResults: new Map(),
		llmClient: { getTokenUsage: () => ({ input: 10, output: 5, cached: 0 }), estimateCost: () => 0.01, streamRequest: (request: { signal: AbortSignal }) => { requests.push(request.signal); return stream(request.signal); } },
		toolRegistry: {
			definitions: () => [],
			get: (name: string) => ({ definition: { category: name === 'write_file' ? 'write' : 'read', riskLevel: name === 'write_file' ? 'requiresApproval' : 'safe' } }),
			execute: async (name: string) => { executed.push(name); return { content: 'Tool result' }; },
		},
	});
	try { await run({ ...fixture, requests, executed, pendingApprovals }); }
	finally { fixture.session.abortInFlight(); Object.assign(vscode.workspace, { getConfiguration: originalConfiguration }); }
}

async function* requestNativeTool(name: string): AsyncGenerator<LlmStreamEvent> {
	yield { type: 'token', token: 'Investigation before the tool' };
	yield { type: 'tool-call', id: 'requested-tool', name, input: { path: 'example.ts', content: 'New content' } };
	yield { type: 'complete', fullText: 'Investigation before the tool', stopReason: 'tool_use', inputTokens: 10, outputTokens: 5, cachedTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

interface NativeRequestBody {
	model: string;
	tools?: Array<{ type: string; function: { name: string; description: string; parameters: ToolDefinition['inputSchema'] } }>;
	messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
}

async function withCatalogNativeSession(
	options: { tools: CapabilityAvailability; images?: boolean; toolReply?: boolean; specialistFallback?: boolean },
	run: (fixture: ReturnType<typeof createSession> & { llm: LlmClient; model: ModelId; bodies: NativeRequestBody[]; definition: ToolDefinition; executed: string[] }) => Promise<void>,
): Promise<void> {
	const rawModel = `chat-panel-${options.tools}-${options.images ?? false}-${options.toolReply ?? false}-${options.specialistFallback ?? false}`;
	const model = discoveredModelId('openai', rawModel);
	registerDiscoveredModels([{ id: model, provider: 'openai', model: rawModel, label: 'Offline chat fixture', chat: true, images: options.images ?? false, tools: options.tools, fetchedAt: Date.now() }]);
	const definition: ToolDefinition = { name: 'write_file', description: 'Write the test fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
	const llm = new LlmClient({ get: async () => 'synthetic-fixture-key', store: async () => {}, delete: async () => {} }, { get: <T>(key: string, fallback?: T): T => (key === 'openaiBaseUrl' ? 'https://fixture.invalid/v1' : fallback) as T });
	const originalFetch = globalThis.fetch; const bodies: NativeRequestBody[] = []; const executed: string[] = [];
	globalThis.fetch = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		const frame = { choices: [{ delta: { content: 'Useful answer', ...(options.toolReply ? { tool_calls: [{ index: 0, id: 'unexpected-tool', function: { name: 'write_file', arguments: '{"path":"fixture.ts"}' } }] } : {}) }, finish_reason: options.toolReply ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
		return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
	};
	const f = createSession();
	Object.assign(f.session, {
		currentModel: model, currentSpecialistId: options.specialistFallback ? 'anton-spec' : 'anton',
		agentBridge: options.specialistFallback ? { hasAgent: () => false } : undefined,
		llmClient: llm, editedToolResults: new Map(),
		toolRegistry: { definitions: () => [definition], get: () => ({ definition: { category: 'write', riskLevel: 'requiresApproval' } }), execute: async (name: string) => { executed.push(name); return { content: 'Written' }; } },
	});
	try { await run({ ...f, llm, model, bodies, definition, executed }); }
	finally { f.session.abortInFlight(); globalThis.fetch = originalFetch; }
}

suite('Chat turn ownership', () => {
	test('direct chat sends tools only for confirmed capability, while text and vision still work', async () => {
		for (const scenario of [
			{ tools: 'unknown', mode: 'act' },
			{ tools: false, mode: 'act', specialistFallback: true },
			{ tools: true, mode: 'act' },
			{ tools: true, mode: 'plan', specialistFallback: true },
			{ tools: 'unknown', mode: 'act', images: true },
		] as const) {
			await withCatalogNativeSession(scenario, async f => {
				await f.session.handleSendMessage({ text: 'Explain this file', includeWorkspaceContext: false, chatMode: scenario.mode, ...('images' in scenario ? { images: [{ mime: 'image/png', base64: 'YWJj' }] } : {}) });
				const response = f.conversations.get('first')?.at(-1);
				const expectedTools = scenario.tools === true && scenario.mode === 'act' ? [{ type: 'function', function: { name: f.definition.name, description: f.definition.description, parameters: f.definition.inputSchema } }] : undefined;
				assert.deepEqual({ requests: f.bodies.length, tools: f.bodies[0]?.tools, content: response?.content, outcome: response?.execution?.outcome, errors: f.messages.filter(message => message.type === 'streamError'), capability: getDiscoveredModel(f.model)?.tools }, { requests: 1, tools: expectedTools, content: 'Useful answer', outcome: 'completed', errors: [], capability: scenario.tools });
				if ('images' in scenario) {
					assert.deepEqual(f.bodies[0].messages.find(message => message.role === 'user')?.content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }, { type: 'text', text: 'Explain this file' }]);
				}
			});
		}
	});

	test('unknown tools and Plan mode reject unsolicited provider tool calls before approval or execution', async () => {
		for (const scenario of [{ tools: 'unknown', mode: 'act' }, { tools: true, mode: 'plan' }] as const) {
			await withCatalogNativeSession({ ...scenario, toolReply: true }, async f => {
				await f.session.handleSendMessage({ text: 'Explain this file', includeWorkspaceContext: false, chatMode: scenario.mode });
				const response = f.conversations.get('first')?.at(-1);
				assert.deepEqual({ requests: f.bodies.length, tools: f.bodies[0]?.tools, executed: f.executed, toolCards: f.messages.some(message => message.type === 'toolCall'), approval: f.messages.some(message => message.type === 'approvalRequest'), complete: f.messages.some(message => message.type === 'messageComplete'), outcome: response?.execution?.outcome }, { requests: 1, tools: undefined, executed: [], toolCards: false, approval: false, complete: false, outcome: 'failed' });
				assert.match(String(f.messages.find(message => message.type === 'streamError')?.error), scenario.mode === 'plan' ? /Plan mode cannot execute tools/ : /not confirmed tool support/);
				if (scenario.tools === 'unknown') {
					await assert.rejects(async () => { for await (const _event of f.llm.streamRequest({ model: f.model, messages: [{ role: 'user', content: 'Run a tool' }], tools: [f.definition] })) { /* consume */ } }, /not advertised tool support/);
					assert.equal(f.bodies.length, 1, 'the runtime capability guard must reject tool-enabled requests before HTTP');
				}
			});
		}
	});

	test('approval and rejection record orchestrator execution even with an ACP specialist selected', async () => {
		for (const command of ['approve', 'reject']) {
			const f = createSession(); let dispatched: string | undefined;
			Object.assign(f.session, { currentSpecialistId: 'anton-code', currentModel: 'claude-code-opus', agentBridge: {
				hasAgent: () => true, getCapabilities: () => ({ transport: 'acp' }),
				runOrchestrator: async (_prompt: string, emit: (event: AgentEvent) => void, _token: vscode.CancellationToken, options: { command?: string }) => { dispatched = options.command; emit({ type: 'token', token: 'Plan handled' }); emit({ type: 'final', text: 'Plan handled' }); },
			} });
			await f.session.handleSendMessage({ text: `/${command}`, includeWorkspaceContext: false });
			assert.deepEqual({ dispatched, route: f.conversations.get('first')?.at(-1)?.execution?.route }, { dispatched: command, route: 'orchestrator' });
		}
	});

	test('real orchestration failures remain failed through bridge, persistence and evaluation export', async () => {
		for (const scenario of [{ mode: 'act', partial: '' }, { mode: 'act', partial: 'Useful partial response' }, { mode: 'plan', partial: '' }] as const) {
			const f = createSession(); const runtime = realOrchestratorBridge(async emit => { if (scenario.partial) { emit?.(scenario.partial); } throw new Error('Provider unavailable'); });
			Object.assign(f.session, { agentBridge: runtime.bridge, currentMode: scenario.mode });
			let exportCommand!: () => Promise<void>; let exported = '';
			const originals = { register: vscode.commands.registerCommand, open: vscode.workspace.openTextDocument, show: vscode.window.showTextDocument };
			try {
				await f.session.handleSendMessage({ text: 'hello', includeWorkspaceContext: false });
				const response = f.conversations.get('first')?.at(-1);
				assert.deepEqual({ role: response?.role, outcome: response?.execution?.outcome, route: response?.execution?.route, terminal: runtime.events.filter(event => event.type === 'error' || event.type === 'final'), errors: f.messages.filter(message => message.type === 'streamError').map(message => message.error), completed: f.messages.some(message => message.type === 'messageComplete') }, { role: 'assistant', outcome: 'failed', route: 'orchestrator', terminal: [{ type: 'error', message: 'Provider unavailable' }], errors: ['Provider unavailable'], completed: false });
				assert.equal(response?.content, scenario.partial || (scenario.mode === 'plan' ? '**Analyzing request and querying code graph...**\n\n' : 'Error: Provider unavailable'));
				response!.feedback = 'down';
				Object.assign(vscode.commands, { registerCommand: (_id: string, handler: typeof exportCommand) => { exportCommand = handler; return { dispose() {} }; } });
				Object.assign(vscode.workspace, { openTextDocument: async (options: { content: string }) => { exported = options.content; return {}; } });
				Object.assign(vscode.window, { showTextDocument: async () => {} });
				registerResponseFeedback({ subscriptions: [] } as unknown as vscode.ExtensionContext, f.store as unknown as ConversationStore);
				await exportCommand();
				const report = JSON.parse(exported);
				assert.deepEqual({ outcomes: report.outcomes, execution: report.examples[0].execution.outcome }, { outcomes: { completed: 0, cancelled: 0, failed: 1, unrecorded: 0 }, execution: 'failed' });
			} finally {
				runtime.bridge.dispose();
				Object.assign(vscode.commands, { registerCommand: originals.register }); Object.assign(vscode.workspace, { openTextDocument: originals.open }); Object.assign(vscode.window, { showTextDocument: originals.show });
			}
		}
	});

	test('real orchestration cancellation retains a cancelled partial answer with no error or final event', async () => {
		const f = createSession(); const started = deferred(); const release = deferred();
		const runtime = realOrchestratorBridge(async emit => { emit?.('Partial answer'); started.resolve(); await release.promise; throw new DOMException('Aborted', 'AbortError'); });
		Object.assign(f.session, { agentBridge: runtime.bridge });
		try {
			const pending = f.session.handleSendMessage({ text: 'hello', includeWorkspaceContext: false }); await started.promise; f.session.abortInFlight(); release.resolve(); await pending;
			const response = f.conversations.get('first')?.at(-1);
			assert.deepEqual({ content: response?.content, outcome: response?.execution?.outcome, terminal: runtime.events.filter(event => event.type === 'error' || event.type === 'final'), errors: f.messages.filter(message => message.type === 'streamError'), completed: f.messages.some(message => message.type === 'messageComplete') }, { content: 'Partial answer', outcome: 'cancelled', terminal: [], errors: [], completed: false });
		} finally { release.resolve(); runtime.bridge.dispose(); }
	});

	test('native zero-tool budget rejects provider-requested tools before execution or approval', async () => {
		await withNativeSession({ 'agents.maxToolCalls': 0 }, () => requestNativeTool('write_file'), async fixture => {
			await fixture.session.handleSendMessage({ text: 'Request a write', includeWorkspaceContext: false });
			const response = fixture.conversations.get('first')?.at(-1);
			assert.deepEqual({ requests: fixture.requests.length, executed: fixture.executed, approval: fixture.messages.some(message => message.type === 'approvalRequest'), completed: fixture.messages.some(message => message.type === 'messageComplete'), outcome: response?.execution?.outcome, route: response?.execution?.route }, { requests: 1, executed: [], approval: false, completed: false, outcome: 'failed', route: 'native' });
			assert.match(String(fixture.messages.find(message => message.type === 'streamError')?.error), /limit of 0 tool calls/);
		});
	});

	test('native runtime budget aborts the provider stream and persists a failed partial response', async () => {
		await withNativeSession({ 'agents.maxRuntimeMs': 1000 }, async function* (signal) {
			yield { type: 'token', token: 'Useful partial answer' };
			await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
			yield { type: 'token', token: ' late output' };
		}, async fixture => {
			await fixture.session.handleSendMessage({ text: 'Slow response', includeWorkspaceContext: false });
			const response = fixture.conversations.get('first')?.at(-1);
			assert.deepEqual({ aborted: fixture.requests[0]?.aborted, content: response?.content, outcome: response?.execution?.outcome, settled: fixture.messages.filter(message => message.type === 'requestSettled'), currentController: fixture.session.abortController, completed: fixture.messages.some(message => message.type === 'messageComplete') }, { aborted: true, content: 'Useful partial answer', outcome: 'failed', settled: [{ type: 'requestSettled', cancelled: true }], currentController: undefined, completed: false });
			assert.match(String(fixture.messages.find(message => message.type === 'streamError')?.error), /runtime limit/);
		});
	});

	test('native runtime budget releases a pending approval without running the requested tool', async () => {
		await withNativeSession({ 'agents.maxRuntimeMs': 1000 }, () => requestNativeTool('write_file'), async fixture => {
			await fixture.session.handleSendMessage({ text: 'Wait for approval', includeWorkspaceContext: false });
			const response = fixture.conversations.get('first')?.at(-1);
			assert.deepEqual({ content: response?.content, outcome: response?.execution?.outcome }, { content: 'Investigation before the tool', outcome: 'failed' });
			assert.deepEqual({ requests: fixture.requests.length, aborted: fixture.requests[0]?.aborted, approvalRequested: fixture.messages.some(message => message.type === 'approvalRequest'), pendingApprovals: fixture.pendingApprovals.size, executed: fixture.executed, settled: fixture.messages.filter(message => message.type === 'requestSettled'), currentController: fixture.session.abortController }, { requests: 1, aborted: true, approvalRequested: true, pendingApprovals: 0, executed: [], settled: [{ type: 'requestSettled', cancelled: true }], currentController: undefined });
			assert.match(String(fixture.messages.find(message => message.type === 'streamError')?.error), /runtime limit/);
		});
	});
	test('deleting an unrelated conversation leaves the current stream running', async () => {
		const f = createSession(); const request = f.send('Keep working'); await request.ready;
		const controller = f.session.abortController;
		f.conversations.delete('second'); f.session.handleConversationDeleted('second');
		assert.equal(controller?.signal.aborted, false);
		request.emit({ type: 'token', token: 'Completed current work' }); request.release(); await request.done;
		assert.equal(f.conversations.get('first')?.at(-1)?.content, 'Completed current work');
	});

	test('deleting the active conversation cancels its stream and ignores late output', async () => {
		const f = createSession(); const request = f.send('Old work'); await request.ready;
		const controller = f.session.abortController;
		f.conversations.delete('first'); f.session.handleConversationDeleted('first');
		const count = f.messages.length;
		request.emit({ type: 'token', token: 'Do not restore deleted work' }); request.release(); await request.done;
		// The replacement conversation's async history refresh can settle after deletion; old stream events cannot.
		const lateMessages = f.messages.slice(count).map(message => ({ type: message.type, activeId: message.activeId, conversationIds: Array.isArray(message.conversations) ? message.conversations.map((summary: { id: string }) => summary.id) : undefined }));
		assert.deepEqual({ aborted: controller?.signal.aborted, resurrected: f.conversations.has('first'), lateMessages }, { aborted: true, resurrected: false, lateMessages: [{ type: 'historySnapshot', activeId: 'second', conversationIds: ['second'] }] });
		assert.equal(f.messages.find(message => message.type === 'loadConversation')?.conversationId, 'second');
	});

	test('deleting the last conversation creates a usable empty replacement', () => {
		const f = createSession(); f.conversations.clear(); f.session.handleConversationDeleted('first');
		assert.deepEqual([...f.conversations], [['fresh', []]]);
		assert.equal(f.messages.find(message => message.type === 'loadConversation')?.conversationId, 'fresh');
	});

	test('history actions and export pass exact conversation ids to shared host commands', async () => {
		const f = createSession(); const calls: Array<[string, string | undefined]> = [];
		const original = vscode.commands.executeCommand;
		Object.assign(vscode.commands, { executeCommand: async (command: string, id?: string) => { calls.push([command, id]); } });
		try {
			await f.receive({ type: 'historyRename', id: 'second' });
			await f.receive({ type: 'historyDelete', id: 'second' });
			await f.receive({ type: 'exportConversation' });
			assert.deepEqual(calls, [['sota.renameConversation', 'second'], ['sota.deleteConversation', 'second'], ['sota.exportConversation', 'first']]);
		} finally { Object.assign(vscode.commands, { executeCommand: original }); }
	});

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

	test('a kinded mention alone dispatches an attachment-only turn', async () => {
		const fixture = createSession();
		await fixture.session.handleSendMessage({ text: '', mentionsKinded: [{ kind: 'terminal' }], includeWorkspaceContext: false });
		assert.equal(fixture.conversations.get('first')?.[0]?.role, 'user');
		assert.ok(fixture.messages.some(message => message.type === 'requestStarted'));
	});

	test('saved user requests retain composer references without resolved context bodies', async () => {
		const fixture = createSession();
		const input = { text: 'Explain the failure', attachments: ['terminal-output'], mentionsKinded: [{ kind: 'file' as const, path: 'src/main.ts' }], includeWorkspaceContext: false, model: 'haiku' as const, chatMode: 'plan' as const };
		await fixture.session.handleSendMessage(input);
		input.attachments.push('current-file'); input.mentionsKinded[0].path = 'changed.ts';
		const saved = fixture.conversations.get('first')?.[0];
		assert.deepEqual({ request: saved?.request, model: saved?.model, specialist: saved?.specialistId }, { request: { excludedContext: undefined, text: 'Explain the failure', attachments: ['terminal-output'], mentions: undefined, mentionsKinded: [{ kind: 'file', path: 'src/main.ts' }], includeWorkspaceContext: false, chatMode: 'plan' }, model: 'haiku', specialist: 'anton' });
	});

	test('specialist selection persists immediately and stale composer preference changes are ignored', async () => {
		const fixture = createSession();
		await fixture.receive({ type: 'selectSpecialist', conversationId: 'first', specialistId: 'anton-code' });
		assert.equal(fixture.models.has('first'), true, 'selection saved before a prompt is sent');
		await fixture.receive({ type: 'selectSpecialist', conversationId: 'second', specialistId: 'anton-test' });
		await fixture.receive({ type: 'selectSpecialist', conversationId: 'first', specialistId: 'not-an-agent' });
		await fixture.receive({ type: 'modeChange', conversationId: 'second', chatMode: 'plan' });
		assert.deepEqual({ specialist: fixture.session.currentSpecialistId, mode: fixture.session.currentMode }, { specialist: 'anton-code', mode: 'act' });
	});

	test('context failures end the loading state with a visible error', async () => {
		const fixture = createSession();
		fixture.session.workspaceContext = { collect: async () => { throw new Error('workspace unavailable'); } };
		await fixture.session.handleSendMessage({ text: 'request' });
		assert.deepEqual(fixture.messages, [{ type: 'streamError', error: 'workspace unavailable' }, { type: 'requestSettled', cancelled: false }]);
	});
});
