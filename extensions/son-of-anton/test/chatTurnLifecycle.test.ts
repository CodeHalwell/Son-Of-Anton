/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { mentionSourceId, type ContextMention } from '../src/chat/ContextSources';
import { ChatTurnQueue } from '../src/chat/ChatTurnQueue';
import { ChatSession, type ChatMessage } from '../src/chat/ChatPanel';
import { LlmClient, type LlmStreamEvent, type ModelId, type ToolDefinition } from 'son-of-anton-core/llm/LlmClient';
import { discoveredAcpModelId, discoveredModelId, getDiscoveredModel, registerDiscoveredModels, replaceDiscoveredModels, type CapabilityAvailability } from 'son-of-anton-core/llm/DiscoveredModels';
import type { AgentEvent } from '../src/chat/agentEvents';
import { AgentBridge } from '../src/chat/AgentBridge';
import { OrchestratorAgent } from 'son-of-anton-core/agents/OrchestratorAgent';
import { AgentManager } from 'son-of-anton-core/agents/AgentManager';
import { MetricsTracker } from 'son-of-anton-core/agents/MetricsTracker';
import { ProjectMemory } from 'son-of-anton-core/agents/ProjectMemory';
import { createAgentStack, type AgentStack } from 'son-of-anton-core/agents/AgentStackFactory';
import { McpClient } from 'son-of-anton-core/mcp/McpClient';
import type { AcpTurn } from 'son-of-anton-core/acp/AcpRuntime';
import type { ConversationStore } from '../src/chat/ConversationStore';
import { registerResponseFeedback } from '../src/chat/ResponseFeedback';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

interface TestSession {
	postSystemMessage(text: string): void;
	setupMessageHandler(): void;
	currentModel: ModelId;
	currentSpecialistId: string;
	currentMode: string;
	handleConversationDeleted(id: string): void;
	handleSendMessage(message: { text: string; excludedContext?: string[]; contextSnapshotId?: string; requestId?: string; conversationId?: string; specialistId?: string; includeWorkspaceContext?: boolean; mentionsKinded?: NonNullable<ChatMessage['request']>['mentionsKinded']; attachments?: string[]; model?: ModelId; chatMode?: 'plan' | 'act'; images?: Array<{ mime: string; base64: string }> }): Promise<void>;
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
	let receive: (message: { type: string; mentionsKinded?: ContextMention[]; excludedContext?: string[]; includeWorkspaceContext?: boolean; conversationId?: string; model?: ModelId; id?: string; specialistId?: string; chatMode?: string; messageIndex?: number; responseId?: string; value?: string; text?: string; queueAction?: string }) => Promise<void>;
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
		loadMessage: (id: string, index: number) => conversations.get(id)?.[index],
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
	function send(text: string, extra: { includeWorkspaceContext?: boolean; requestId?: string } = {}) {
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
	messages: Array<{ role: string; reasoning_content?: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
}

async function withCatalogNativeSession(
	options: { tools: CapabilityAvailability; images?: CapabilityAvailability; toolReply?: boolean; specialistFallback?: boolean; provider?: 'moonshot'; readTool?: boolean; frames?: (request: number) => object[] },
	run: (fixture: ReturnType<typeof createSession> & { llm: LlmClient; model: ModelId; bodies: NativeRequestBody[]; definition: ToolDefinition; executed: string[] }) => Promise<void>,
): Promise<void> {
	const rawModel = `chat-panel-${options.tools}-${options.images ?? false}-${options.toolReply ?? false}-${options.specialistFallback ?? false}`;
	const provider = options.provider ?? 'openai';
	const model = discoveredModelId(provider, rawModel);
	registerDiscoveredModels([{ id: model, provider, model: rawModel, label: 'Offline chat fixture', chat: true, images: options.images ?? false, tools: options.tools, fetchedAt: Date.now() }]);
	const definition: ToolDefinition = { name: options.readTool ? 'read_file' : 'write_file', description: 'Access the test fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
	const llm = new LlmClient({ get: async () => 'synthetic-fixture-key', store: async () => {}, delete: async () => {} }, { get: <T>(key: string, fallback?: T): T => (key === `${provider}BaseUrl` ? 'https://fixture.invalid/v1' : fallback) as T });
	const originalFetch = globalThis.fetch; const bodies: NativeRequestBody[] = []; const executed: string[] = [];
	globalThis.fetch = async (_input, init) => {
		bodies.push(JSON.parse(String(init?.body)));
		const frame = { choices: [{ delta: { content: 'Useful answer', ...(options.toolReply ? { tool_calls: [{ index: 0, id: 'unexpected-tool', function: { name: 'write_file', arguments: '{"path":"fixture.ts"}' } }] } : {}) }, finish_reason: options.toolReply ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
		const frames = options.frames?.(bodies.length) ?? [frame];
		return new Response(`${frames.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
	};
	const f = createSession();
	Object.assign(f.session, {
		currentModel: model, currentSpecialistId: options.specialistFallback ? 'anton-spec' : 'anton',
		agentBridge: options.specialistFallback ? { hasAgent: () => false } : undefined,
		llmClient: llm, editedToolResults: new Map(),
		toolRegistry: { definitions: () => [definition], get: () => ({ definition: options.readTool ? { category: 'read', riskLevel: 'safe' } : { category: 'write', riskLevel: 'requiresApproval' } }), execute: async (name: string) => { executed.push(name); return { content: options.readTool ? 'Fixture contents' : 'Written' }; } },
	});
	try { await run({ ...f, llm, model, bodies, definition, executed }); }
	finally { f.session.abortInFlight(); globalThis.fetch = originalFetch; }
}

async function withAcpSession(run: (fixture: ReturnType<typeof createSession> & { model: ModelId; otherModel: ModelId; turns: AcpTurn[]; settings: Record<string, unknown>; stack: AgentStack }) => Promise<void>): Promise<void> {
	const workspace = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted };
	Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file((process as NodeJS.Process).cwd()), name: 'Fixture', index: 0 }], isTrusted: true });
	const adapters = ['chat-route-codex', 'chat-route-gemini'].map(id => ({ id, command: process.execPath, args: ['fixture-adapter.cjs'] }));
	const [model, otherModel] = adapters.map(adapter => discoveredAcpModelId(adapter.id, 'exact-model'));
	registerDiscoveredModels(adapters.map(adapter => ({ id: discoveredAcpModelId(adapter.id, 'exact-model'), provider: 'acp', acpAdapterId: adapter.id, model: 'exact-model', label: adapter.id, chat: true, tools: true, images: true, fetchedAt: Date.now() })));
	const settings: Record<string, unknown> = { 'sota.acp.agents': adapters, 'sota.agents.anton-code.acpAgent': adapters[1].id };
	const config = { get: <T>(key: string, fallback?: T) => (settings[key] ?? fallback) as T };
	const llm = new LlmClient({ get: async () => { assert.fail('ACP selections must not use native credentials or inference'); }, store: async () => {}, delete: async () => {} }, config);
	const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => (process as NodeJS.Process).cwd(), onSettingChange: () => ({ dispose() {} }) });
	const stack = createAgentStack({ llmClient: llm, mcpClient: mcp, agentManager: new AgentManager(llm), globalState: { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => {} }, workspaceRoot: (process as NodeJS.Process).cwd(), configStore: config, canUseAcp: () => true, persistMetrics: false });
	const turns: AcpTurn[] = [];
	stack.acpRuntime!.run = async turn => { turns.push(turn); turn.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Adapter answer' } }); return { stopReason: 'end_turn' }; };
	const bridge = new AgentBridge(stack); const f = createSession(); Object.assign(f.session, { agentBridge: bridge, llmClient: llm });
	try { await run({ ...f, model, otherModel, turns, settings, stack }); }
	finally { Object.assign(vscode.workspace, workspace); f.session.abortInFlight(); bridge.dispose(); stack.dispose(); await stack.acpRuntime?.shutdown(); mcp.dispose(); for (const adapter of adapters) replaceDiscoveredModels({ provider: 'acp', acpAdapterId: adapter.id }, []); }
}

suite('ACP chat model routing', () => {
	test('workspace preflight rejects ACP before hooks, context, persistence and runtime', async () => {
		await withAcpSession(async f => {
			const folder = vscode.workspace.workspaceFolders;
			Object.assign(f.session, {
				hookRunner: { fire: async () => assert.fail('No hooks before workspace preflight') },
				workspaceContext: { collect: async () => assert.fail('No context before workspace preflight') },
			});
			for (const state of [{ workspaceFolders: undefined, isTrusted: true }, { workspaceFolders: folder, isTrusted: false }]) {
				Object.assign(vscode.workspace, state);
				await f.session.handleSendMessage({ text: 'Keep this draft', specialistId: 'anton-code', model: f.model });
				assert.match(String(f.messages.findLast(message => message.type === 'streamError')?.error), /Your prompt has not been sent/);
				assert.deepEqual({ turns: f.turns, transcript: f.conversations.get('first') }, { turns: [], transcript: [] });
			}
		});
	});

	test('model selection remaps direct-only and removed personas and routes the exact adapter/model', async () => {
		await withAcpSession(async f => {
			for (const specialistId of ['anton-spec', 'custom-persona', 'anton']) {
				f.session.currentModel = 'sonnet'; f.session.currentSpecialistId = specialistId;
				await f.receive({ type: 'selectModel', conversationId: 'first', model: f.model, specialistId });
				assert.equal(f.session.currentSpecialistId, 'anton-code'); assert.equal(f.session.currentModel, f.model);
				assert.deepEqual(f.messages.findLast(message => message.type === 'chatSelection'), { type: 'chatSelection', conversationId: 'first', requestedModel: f.model, requestedSpecialistId: specialistId, model: f.model, specialistId: 'anton-code', error: undefined });
				await f.session.handleSendMessage({ text: 'Use this exact model', model: f.model, specialistId, includeWorkspaceContext: false });
				assert.equal(f.turns.at(-1)?.agent.id, 'chat-route-codex'); assert.equal(f.turns.at(-1)?.agent.modelId, 'exact-model');
				assert.equal(f.conversations.get('first')?.at(-1)?.execution?.route, 'acp');
			}
		});
	});

	test('registered specialists and other available adapters retain the requested persona and model', async () => {
		await withAcpSession(async f => {
			await f.receive({ type: 'selectModel', conversationId: 'first', model: f.otherModel, specialistId: 'anton-docs' });
			assert.equal(f.session.currentSpecialistId, 'anton-docs');
			await f.session.handleSendMessage({ text: 'Plan from an image', model: f.otherModel, specialistId: 'anton-docs', chatMode: 'plan', images: [{ mime: 'image/png', base64: 'YWJj' }], includeWorkspaceContext: false });
			assert.equal(f.turns[0].agent.id, 'chat-route-gemini'); assert.equal(f.turns[0].modeId, 'plan');
			assert.deepEqual(f.turns[0].images, [{ mimeType: 'image/png', data: 'YWJj' }]);
			assert.equal(f.turns[0].maxToolCalls, 100); assert.equal(f.turns[0].timeoutMs, 300_000);
			assert.equal(f.turns[0].conversationId, 'anton-docs:first');
		});
	});

	test('a missing preferred specialist falls back only to another concrete ACP route', async () => {
		await withAcpSession(async f => {
			Object.assign(f.stack, { specialists: new Map([...f.stack.specialists].filter(([id]) => id !== 'anton-code')) });
			await f.receive({ type: 'selectModel', conversationId: 'first', model: f.model, specialistId: 'anton-spec' });
			assert.equal(f.session.currentSpecialistId, 'anton-test');
			await f.session.handleSendMessage({ text: 'Still available', model: f.model, specialistId: 'anton-spec', includeWorkspaceContext: false });
			assert.equal(f.turns[0].conversationId, 'anton-test:first');
		});
	});

	test('unavailable adapter selection is rejected atomically and sends settle before persistence or hooks', async () => {
		await withAcpSession(async f => {
			f.settings['sota.acp.agents'] = [];
			Object.assign(f.session, { hookRunner: { fire: () => assert.fail('Route validation precedes hooks') }, checkpointManager: { capture: () => assert.fail('Route validation precedes checkpoints') } });
			await f.receive({ type: 'selectModel', conversationId: 'first', model: f.model, specialistId: 'anton-spec' });
			assert.deepEqual([f.session.currentModel, f.session.currentSpecialistId], ['sonnet', 'anton']);
			assert.match(String(f.messages.findLast(message => message.type === 'chatSelection')?.error), /Browse ACP Adapters/);
			await f.session.handleSendMessage({ text: 'Keep this prompt', model: f.model, specialistId: 'anton-spec', requestId: 'rejected-adapter' });
			assert.match(String(f.messages.findLast(message => message.type === 'streamError')?.error), /Browse ACP Adapters/);
			assert.equal(f.messages.findLast(message => message.type === 'requestSettled')?.requestId, 'rejected-adapter');
			assert.deepEqual(f.conversations.get('first'), []); assert.equal(f.turns.length, 0); assert.equal(f.session.abortController, undefined);
		});
	});

	test('a retired catalog and a missing bridge cannot fall through to native inference', async () => {
		await withAcpSession(async f => {
			replaceDiscoveredModels({ provider: 'acp', acpAdapterId: 'chat-route-codex' }, []);
			await f.session.handleSendMessage({ text: 'Retired', model: f.model, specialistId: 'anton-spec' });
			assert.match(String(f.messages.findLast(message => message.type === 'streamError')?.error), /model is unavailable/);
			Object.assign(f.session, { agentBridge: undefined });
			await f.session.handleSendMessage({ text: 'No bridge', model: f.otherModel, specialistId: 'anton-spec' });
			assert.match(String(f.messages.findLast(message => message.type === 'streamError')?.error), /configured agent adapter/);
			assert.deepEqual(f.conversations.get('first'), []); assert.equal(f.turns.length, 0);
		});
	});

	test('queued and redirect drafts validate before acceptance or cancellation, and revalidate at dispatch', async () => {
		await withAcpSession(async f => {
			const controller = new AbortController(); f.session.abortController = controller;
			await f.receive({ type: 'queueMessage', conversationId: 'first', id: 'queued', text: 'Queued prompt', model: f.model, specialistId: 'anton-spec' });
			assert.equal(f.messages.findLast(message => message.type === 'queueAccepted')?.id, 'queued');
			f.settings['sota.acp.agents'] = [];
			await f.receive({ type: 'redirectMessage', conversationId: 'first', id: 'invalid-redirect', text: 'Keep active turn', model: f.model, specialistId: 'anton-spec' });
			assert.equal(controller.signal.aborted, false); assert.equal(f.messages.findLast(message => message.type === 'queueError')?.id, 'invalid-redirect');
			f.session.abortController = undefined;
			await f.receive({ type: 'queueAction', conversationId: 'first', queueAction: 'resume' });
			for (let wait = 0; f.session.abortController && wait < 50; wait++) await new Promise<void>(resolve => setImmediate(resolve));
			const queue = (f.session as unknown as { followupQueue: ChatTurnQueue<{ text?: string; specialistId?: string }> }).followupQueue.snapshot('first');
			assert.equal(queue.paused, true); assert.equal(queue.entries[0]?.draft.text, 'Queued prompt'); assert.equal(queue.entries[0]?.draft.specialistId, 'anton-code');
			assert.deepEqual(f.conversations.get('first'), []); assert.equal(f.turns.length, 0);
		});
	});

	test('history and defaults that restore incompatible personas are normalized by the actual send path', async () => {
		await withAcpSession(async f => {
			const load = f.store.load;
			f.store.load = id => { const record = load(id); return record && { ...record, summary: { ...record.summary, ...(id === 'second' ? { lastModel: f.model, lastSpecialist: 'custom-persona' } : {}) } }; };
			f.session.switchConversation('second');
			assert.equal(f.session.currentModel, f.model); assert.equal(f.session.currentSpecialistId, 'anton-code');
			await f.session.handleSendMessage({ text: 'Restored selection', includeWorkspaceContext: false });
			assert.equal(f.session.currentSpecialistId, 'anton-code'); assert.equal(f.turns[0].agent.id, 'chat-route-codex');
			await f.receive({ type: 'selectSpecialist', conversationId: 'second', model: f.model, specialistId: 'anton-spec' });
			assert.equal(f.session.currentSpecialistId, 'anton-code');
		});
	});

	test('slash model changes acknowledge the previous pair and specialist changes report the resolved persona', async () => {
		await withAcpSession(async f => {
			f.session.currentSpecialistId = 'anton-spec';
			await f.session.handleSendMessage({ text: `/model ${f.model}` });
			assert.deepEqual(f.messages.findLast(message => message.type === 'chatSelection'), { type: 'chatSelection', conversationId: 'first', requestedModel: 'sonnet', requestedSpecialistId: 'anton-spec', model: f.model, specialistId: 'anton-code', error: undefined });
			await f.session.handleSendMessage({ text: '/specialist anton-spec' });
			assert.equal(f.session.currentSpecialistId, 'anton-code');
			assert.match(String(f.conversations.get('first')?.at(-1)?.content), /Switched specialist to \*\*Anton Code\*\*/);
			assert.equal(f.turns.length, 0);
		});
	});
});

suite('Chat turn ownership', () => {
	test('webview bootstrap replays the active binding and available transcript text without restarting', async () => {
		const f = createSession();
		Object.assign(f.session, { postHistorySnapshot() {}, postBoardSnapshot() {}, postCheckpointsForCurrentConversation() {}, refreshConnectionState: async () => {} });
		const request = f.send('Reload question', { requestId: 'reloaded-request' }); await request.ready;
		request.emit({ type: 'token', token: 'Before reload. ' });
		await f.receive({ type: 'webviewReady' });
		const resumed = f.messages.find(message => message.type === 'turnResumed')!;
		assert.deepEqual({ requestId: resumed.requestId, userMessageIndex: resumed.userMessageIndex, assistantMessageIndex: resumed.assistantMessageIndex, partialText: resumed.partialText }, { requestId: 'reloaded-request', userMessageIndex: 0, assistantMessageIndex: undefined, partialText: 'Before reload. ' });
		const loaded = f.messages.find(message => message.type === 'loadConversation')!;
		assert.deepEqual((loaded.messages as Array<{ role: string; persistedIndex: number }>).map(message => ({ role: message.role, index: message.persistedIndex })), [{ role: 'user', index: 0 }]);
		request.emit({ type: 'token', token: 'After reload.' }); request.release(); await request.done;
		assert.equal(f.messages.find(message => message.type === 'messagePersisted' && message.role === 'assistant')?.turnId, resumed.turnId);
		assert.equal(f.conversations.get('first')?.[1].content, 'Before reload. After reload.');
	});

	test('only actual saved assistant rows receive action identities after rejected or local sends', async () => {
		for (const rejection of ['slash', 'hook', 'cap', 'context', 'image']) {
			const f = createSession();
			if (rejection === 'hook') Object.assign(f.session, { hookRunner: { fire: async () => ({ allowed: false }) } });
			if (rejection === 'cap') Object.assign(f.session, { spendGuard: { checkSessionCap: () => ({ blocked: true, currentUsd: 1, capUsd: 1 }) } });
			if (rejection === 'context') f.session.workspaceContext = { collect: async () => { throw new Error('Unavailable'); } };
			await f.session.handleSendMessage({ text: rejection === 'slash' ? '/help' : 'Rejected', requestId: 'rejected', ...(rejection === 'image' ? { images: [{ mime: 'invalid', base64: 'invalid' }] } : {}) });
			assert.equal(f.messages.some(message => message.type === 'messagePersisted'), false, rejection);
			Object.assign(f.session, { hookRunner: undefined, spendGuard: undefined, workspaceContext: undefined });
			for (const requestId of ['first-success', 'second-success']) {
				const request = f.send(requestId, { requestId, includeWorkspaceContext: false }); await request.ready;
				request.emit({ type: 'token', token: `Answer to ${requestId}` });
				if (requestId === 'first-success') f.session.postSystemMessage('Settings changed during the response');
				request.release(); await request.done;
			}
			const responses = f.messages.filter(message => message.type === 'messagePersisted' && message.role === 'assistant');
			assert.equal(responses.length, 2);
			for (const response of responses) {
				const index = Number(response.messageIndex);
				assert.equal(f.store.load('first')?.messages[index].content, `Answer to ${response.requestId}`);
				assert.ok(f.messages.indexOf(response) > f.messages.findIndex(message => message.type === 'messageComplete' && message.turnId === response.turnId));
				assert.ok(f.messages.filter(message => message.requestId === response.requestId && ['streamToken', 'messageMetrics', 'messageComplete', 'requestSettled'].includes(message.type)).every(message => message.turnId === response.turnId && message.conversationId === 'first'));
			}
			await f.receive({ type: 'feedback', conversationId: 'first', messageIndex: Number(responses[1].messageIndex), responseId: String(responses[0].responseId), value: 'down' });
			await f.receive({ type: 'feedback', conversationId: 'first', messageIndex: Number(responses[1].messageIndex), value: 'down' });
			await f.receive({ type: 'feedback', conversationId: 'first', messageIndex: Number(responses[0].messageIndex), responseId: String(responses[0].responseId), value: 'up' });
			assert.deepEqual(f.store.load('first')?.messages.filter(message => message.role === 'assistant').map(message => message.feedback), ['up', undefined]);
		}
	});

	test('branch and feedback reject stale, replaced, missing and non-assistant store identities', async () => {
		const f = createSession(); const request = f.send('saved', { requestId: 'saved' }); await request.ready;
		request.emit({ type: 'token', token: 'Saved response' }); request.release(); await request.done;
		const ack = f.messages.find(message => message.type === 'messagePersisted' && message.role === 'assistant')!;
		const identity = { conversationId: 'first', messageIndex: Number(ack.messageIndex), responseId: String(ack.responseId) };
		const commands: unknown[][] = []; const execute = vscode.commands.executeCommand;
		Object.assign(vscode.commands, { executeCommand: async (...args: unknown[]) => { commands.push(args); } });
		try {
			for (const invalid of [{ ...identity, responseId: undefined }, { ...identity, conversationId: 'second' }, { ...identity, messageIndex: 0 }, { ...identity, responseId: 'invented' }]) await f.receive({ type: 'branchResponse', ...invalid });
			assert.deepEqual(commands, []);
			await f.receive({ type: 'branchResponse', ...identity }); assert.deepEqual(commands, [['sota.branchConversation', 'first', 1]]);
			const original = f.conversations.get('first')!;
			f.conversations.set('first', [original[0], { role: 'system', content: original[1].content, timestamp: original[1].timestamp }]);
			await f.receive({ type: 'branchResponse', ...identity }); await f.receive({ type: 'feedback', ...identity, value: 'down' });
			assert.equal(commands.length, 1); assert.equal(original[1].feedback, undefined);
			f.conversations.set('first', original); Object.assign(f.session, { conversation: original.map(message => ({ ...message })) });
			await f.receive({ type: 'branchResponse', ...identity }); assert.equal(commands.length, 1, 'a replaced transcript needs freshly issued references');
		} finally { Object.assign(vscode.commands, { executeCommand: execute }); }
	});

	test('native completion cannot grant an identity before iterator cleanup or for an unpersisted error', async () => {
		for (const outcome of ['completed', 'empty', 'throw']) {
			const gate = deferred(); const complete = deferred();
			await withNativeSession({}, async function* () {
				if (outcome !== 'empty') yield { type: 'token', token: 'Native response' };
				if (outcome === 'throw') throw new Error('Stream failed after text');
				yield { type: 'complete', fullText: outcome === 'empty' ? '' : 'Native response', stopReason: 'end_turn', inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
				complete.resolve(); await gate.promise;
			}, async f => {
				const done = f.session.handleSendMessage({ text: 'Native question', requestId: outcome, includeWorkspaceContext: false });
				if (outcome !== 'throw') {
					await complete.promise;
					assert.equal(f.messages.some(message => message.type === 'messageComplete'), true);
					assert.equal(f.messages.some(message => message.type === 'messagePersisted' && message.role === 'assistant'), false);
					gate.resolve();
				}
				await done;
				assert.equal(f.messages.filter(message => message.type === 'messagePersisted' && message.role === 'assistant').length, outcome === 'completed' ? 1 : 0);
			});
		}
	});

	test('preview exclusions follow a URL after an earlier chip is removed from the actual native request', async () => {
		await withCatalogNativeSession({ tools: false, specialistFallback: true }, async f => {
			const reads: string[] = [];
			Object.assign(f.session, { resolveKindedMentions: async (mentions: ContextMention[]) => { const id = mentionSourceId(mentions[0]); reads.push(id); return id === privateId ? 'PRIVATE_SOURCE_BODY' : 'PUBLIC_SOURCE_BODY'; } });
			const publicMention: ContextMention = { kind: 'url', url: 'https://example.com/public' };
			const privateMention: ContextMention = { kind: 'url', url: 'https://example.com/private' };
			const privateId = mentionSourceId(privateMention);
			await f.receive({ type: 'previewWorkspaceContext', conversationId: 'first', id: 'both', includeWorkspaceContext: false, mentionsKinded: [publicMention, privateMention] });
			reads.length = 0;
			await f.receive({ type: 'previewWorkspaceContext', conversationId: 'first', id: 'exclude-private', includeWorkspaceContext: false, mentionsKinded: [publicMention, privateMention], excludedContext: [privateId] });
			const preview = f.messages.at(-1)!;
			await f.session.handleSendMessage({ text: 'Explain the selected sources', conversationId: 'first', includeWorkspaceContext: false, mentionsKinded: [privateMention], excludedContext: [privateId], contextSnapshotId: String(preview.id) });
			assert.deepEqual({ reads, requests: f.bodies.length, prompt: f.bodies[0]?.messages.find(message => message.role === 'user')?.content, excluded: f.conversations.get('first')?.[0].request?.excludedContext }, { reads: [mentionSourceId(publicMention)], requests: 1, prompt: 'Explain the selected sources', excluded: [privateId] });
			assert.ok(!JSON.stringify(f.bodies).includes('PRIVATE_SOURCE_BODY'));
		});
	});

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

	test('direct image requests reject unsupported and unknown capability before hooks, context or persistence', async () => {
		for (const images of [false, 'unknown'] as const) {
			for (const specialistFallback of [false, true]) {
				for (const chatMode of ['act', 'plan'] as const) {
					await withCatalogNativeSession({ tools: true, images, specialistFallback }, async f => {
						const effects: string[] = [];
						Object.assign(f.session, {
							hookRunner: { fire: async () => { effects.push('hook'); return { allowed: true }; } },
							workspaceContext: { collect: async () => { effects.push('context'); return { markdown: 'Workspace', estimatedTokens: 1 }; } },
							checkpointManager: { capture: async () => { effects.push('checkpoint'); return undefined; } },
						});
						await f.session.handleSendMessage({ text: 'Read this image', requestId: 'unsupported-image', chatMode, images: [{ mime: 'image/png', base64: 'YWJj' }] });
						assert.deepEqual(effects, []); assert.deepEqual(f.bodies, []); assert.deepEqual(f.executed, []); assert.deepEqual(f.conversations.get('first'), []);
						assert.equal(f.messages.some(message => ['messagePersisted', 'approvalRequest', 'requestStarted', 'checkpointCaptured'].includes(message.type)), false);
						assert.match(String(f.messages.find(message => message.type === 'streamError')?.error), /image-capable model or remove the attachments/);
						assert.equal(f.messages.find(message => message.type === 'requestSettled')?.requestId, 'unsupported-image'); assert.equal(f.session.abortController, undefined);
					});
				}
			}
		}
	});

	test('restored direct history images reject a text-only model without losing the existing conversation', async () => {
		await withCatalogNativeSession({ tools: false, images: false, specialistFallback: true }, async f => {
			const history: ChatMessage[] = [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', base64Data: 'YWJj' }, { type: 'text', text: 'Earlier screenshot' }], timestamp: 1 }];
			f.conversations.set('second', history);
			f.session.switchConversation('second'); f.session.currentModel = f.model;
			await f.session.handleSendMessage({ text: 'Explain that screenshot again', requestId: 'history-image', includeWorkspaceContext: false });
			assert.deepEqual(f.bodies, []); assert.deepEqual(f.conversations.get('second'), history);
			assert.match(String(f.messages.findLast(message => message.type === 'streamError')?.error), /conversation includes images.*image-capable model or start a new chat/);
			assert.equal(f.messages.findLast(message => message.type === 'requestSettled')?.requestId, 'history-image');
		});
	});

	test('confirmed direct vision routes serialize fresh and restored images in Act and Plan modes', async () => {
		for (const chatMode of ['act', 'plan'] as const) {
			await withCatalogNativeSession({ tools: 'unknown', images: true, specialistFallback: true }, async f => {
				f.conversations.set('second', [{ role: 'user', content: [{ type: 'image', mimeType: 'image/png', base64Data: 'YWJj' }, { type: 'text', text: 'Old screenshot' }], timestamp: 1 }]);
				f.session.switchConversation('second'); f.session.currentModel = f.model;
				await f.session.handleSendMessage({ text: 'Compare the screenshots', images: [{ mime: 'image/jpeg', base64: 'ZGVm' }], includeWorkspaceContext: false, chatMode });
				const users = f.bodies[0].messages.filter(message => message.role === 'user');
				assert.deepEqual(users.map(message => message.content), [
					[{ type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }, { type: 'text', text: 'Old screenshot' }],
					[{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZGVm' } }, { type: 'text', text: 'Compare the screenshots' }],
				]);
				assert.equal(f.conversations.get('second')?.at(-1)?.execution?.outcome, 'completed'); assert.equal(f.messages.some(message => message.type === 'streamError'), false);
			});
		}
	});

	test('Moonshot continuation preserves each round of reasoning and correlated tools without displaying or persisting reasoning', async () => {
		await withCatalogNativeSession({ tools: true, provider: 'moonshot', readTool: true, specialistFallback: true, frames: request => request <= 3 ? [
			{ choices: [{ delta: request <= 2 ? { reasoning_content: 'Opaque provider ' } : {} }] },
			{ choices: [{ delta: { ...(request <= 2 ? { reasoning_content: `reasoning ${request}` } : {}), ...(request === 1 ? {} : { content: `Reading ${request}.` }), tool_calls: [{ index: 0, id: `call-${request}`, function: { name: 'read_file', arguments: JSON.stringify({ path: `file-${request}.ts` }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
		] : [{ choices: [{ delta: { content: 'Finished' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }] }, async f => {
			const registry = (f.session as unknown as { toolRegistry: { execute(name: string): Promise<{ content: string; isError?: boolean }> } }).toolRegistry;
			registry.execute = async name => { f.executed.push(name); return { content: `Result ${f.executed.length}`, isError: f.executed.length === 2 }; };
			await f.session.handleSendMessage({ text: 'Investigate three files', includeWorkspaceContext: false });
			assert.equal(f.bodies.length, 4); assert.equal(f.executed.length, 3);
			for (let round = 1; round <= 3; round++) {
				const wire = f.bodies[round].messages;
				const assistants = wire.filter(message => message.role === 'assistant');
				assert.equal(assistants.length, round);
				assert.deepEqual(assistants.map(message => message.reasoning_content), ['Opaque provider reasoning 1', 'Opaque provider reasoning 2', undefined].slice(0, round));
				assert.deepEqual(assistants[round - 1].tool_calls, [{ id: `call-${round}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: `file-${round}.ts` }) } }]);
				assert.deepEqual(wire.filter(message => message.role === 'tool').map(message => ({ id: message.tool_call_id, result: message.content })), Array.from({ length: round }, (_, index) => ({ id: `call-${index + 1}`, result: `Result ${index + 1}` })));
			}
			assert.equal(f.bodies[1].messages.find(message => message.role === 'assistant')?.content, null, 'A reasoning-only tool call still needs a correlated assistant message');
			assert.equal(f.conversations.get('first')?.at(-1)?.execution?.outcome, 'completed');
			assert.doesNotMatch(JSON.stringify(f.messages), /Opaque provider/); assert.doesNotMatch(JSON.stringify(f.conversations.get('first')), /Opaque provider|reasoningContent/);
			await f.session.handleSendMessage({ text: 'Thanks', includeWorkspaceContext: false });
			assert.equal(f.bodies[4].messages.some(message => message.reasoning_content !== undefined || message.tool_calls?.length), false, 'Provider-only continuation metadata must not leak into another user turn');
		});
	});

	test('cancelling Moonshot during a tool discards private continuation reasoning and starts no further request', async () => {
		await withCatalogNativeSession({ tools: true, provider: 'moonshot', readTool: true, frames: () => [{ choices: [{ delta: { content: 'Visible progress', reasoning_content: 'Private cancellation reasoning', tool_calls: [{ index: 0, id: 'cancel-call', function: { name: 'read_file', arguments: '{"path":"file.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }] }, async f => {
			const started = deferred(); const release = deferred();
			const registry = (f.session as unknown as { toolRegistry: { execute(name: string): Promise<{ content: string }> } }).toolRegistry;
			registry.execute = async name => { f.executed.push(name); started.resolve(); await release.promise; return { content: 'Late tool result' }; };
			const running = f.session.handleSendMessage({ text: 'Read a file', includeWorkspaceContext: false, requestId: 'cancel-reasoning' });
			try { await started.promise; f.session.abortController!.abort(); } finally { release.resolve(); await running; }
			assert.equal(f.bodies.length, 1); assert.deepEqual(f.executed, ['read_file']);
			assert.equal(f.conversations.get('first')?.at(-1)?.execution?.outcome, 'cancelled');
			assert.equal(f.messages.findLast(message => message.type === 'requestSettled')?.requestId, 'cancel-reasoning');
			assert.doesNotMatch(JSON.stringify(f.messages), /Private cancellation reasoning/); assert.doesNotMatch(JSON.stringify(f.conversations.get('first')), /Private cancellation reasoning|Late tool result/);
		});
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
			assert.deepEqual({ aborted: fixture.requests[0]?.aborted, content: response?.content, outcome: response?.execution?.outcome, settled: fixture.messages.filter(message => message.type === 'requestSettled').map(({ type, cancelled }) => ({ type, cancelled })), currentController: fixture.session.abortController, completed: fixture.messages.some(message => message.type === 'messageComplete') }, { aborted: true, content: 'Useful partial answer', outcome: 'failed', settled: [{ type: 'requestSettled', cancelled: true }], currentController: undefined, completed: false });
			assert.match(String(fixture.messages.find(message => message.type === 'streamError')?.error), /runtime limit/);
		});
	});

	test('native runtime budget releases a pending approval without running the requested tool', async () => {
		await withNativeSession({ 'agents.maxRuntimeMs': 1000 }, () => requestNativeTool('write_file'), async fixture => {
			await fixture.session.handleSendMessage({ text: 'Wait for approval', includeWorkspaceContext: false });
			const response = fixture.conversations.get('first')?.at(-1);
			assert.deepEqual({ content: response?.content, outcome: response?.execution?.outcome }, { content: 'Investigation before the tool', outcome: 'failed' });
			assert.deepEqual({ requests: fixture.requests.length, aborted: fixture.requests[0]?.aborted, approvalRequested: fixture.messages.some(message => message.type === 'approvalRequest'), pendingApprovals: fixture.pendingApprovals.size, executed: fixture.executed, settled: fixture.messages.filter(message => message.type === 'requestSettled').map(({ type, cancelled }) => ({ type, cancelled })), currentController: fixture.session.abortController }, { requests: 1, aborted: true, approvalRequested: true, pendingApprovals: 0, executed: [], settled: [{ type: 'requestSettled', cancelled: true }], currentController: undefined });
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
		assert.equal(fixture.messages.filter(message => message.type === 'requestSettled').map(({ type, cancelled }) => ({ type, cancelled })).length, 1);
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
		assert.deepEqual(fixture.messages.filter(message => message.type === 'requestSettled').map(({ type, cancelled }) => ({ type, cancelled })), [{ type: 'requestSettled', cancelled: true }]);
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
		assert.deepEqual(fixture.messages.filter(message => message.type !== 'turnAccepted').map(({ conversationId: _conversation, requestId: _request, turnId: _turn, ...message }) => message), [{ type: 'streamError', error: 'workspace unavailable' }, { type: 'requestSettled', cancelled: false }]);
	});
});
