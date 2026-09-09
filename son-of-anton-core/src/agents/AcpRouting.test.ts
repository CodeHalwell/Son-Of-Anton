/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createAgentStack } from './AgentStackFactory';
import { AgentManager } from './AgentManager';
import { discoveredModelId, registerDiscoveredModels } from '../llm/DiscoveredModels';
import { LlmClient } from '../llm/LlmClient';
import { McpClient } from '../mcp/McpClient';
import type { CancellationLike } from '../chatStream';
import type { SubtaskResult } from './types';

const cancellation: CancellationLike = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const result = (summary: string): SubtaskResult => ({ success: true, summary, changes: [], tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0 } });

test('canonical factory routes a configured specialist through ACP with no model API calls', async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'acp-routing-'));
	const settings: Record<string, unknown> = {
		'sota.agents.anton-code.acpAgent': 'fixture',
		'sota.acp.agents': [{ id: 'fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')] }],
	};
	const config = { get: <T>(key: string, fallback?: T): T => (settings[key] ?? fallback) as T };
	const llm = new LlmClient({ get: async () => { throw new Error('Direct model provider must not be called'); }, store: async () => {}, delete: async () => {} }, config);
	const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => root, onSettingChange: () => ({ dispose() {} }) });
	let trusted = true;
	const stack = createAgentStack({ llmClient: llm, mcpClient: mcp, agentManager: new AgentManager(llm), globalState: { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => {} }, workspaceRoot: root, configStore: config, canUseAcp: () => trusted });
	t.after(async () => { await stack.dispose(); mcp.dispose(); await rm(root, { recursive: true, force: true }); });
	const agent = stack.specialists.get('anton-code')!;
	let text = '';
	await agent.runAgenticTurn('hello', event => { if (event.type === 'token') { text += event.token; } }, cancellation, { conversationId: 'conversation' });
	assert.ok(text.endsWith('😀'));
	await agent.runChatTurn('follow-up', () => {}, cancellation, { conversationId: 'conversation' });
	assert.equal(stack.acpRuntime?.snapshot().reused, 1);
	trusted = false;
	await assert.rejects(agent.runChatTurn('blocked', () => {}, cancellation), /trusted workspace/);
});
test('review verdicts cannot turn malformed responses, failed checks or blockers into approval', async t => {
	const llm = new LlmClient({ get: async () => undefined, store: async () => {}, delete: async () => {} }, { get: <T>(_key: string, fallback?: T) => fallback as T });
	const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => undefined, onSettingChange: () => ({ dispose() {} }) });
	const stack = createAgentStack({ llmClient: llm, mcpClient: mcp, agentManager: new AgentManager(llm), globalState: { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => {} }, workspaceRoot: undefined });
	t.after(async () => { await stack.dispose(); mcp.dispose(); });
	const review = stack.specialists.get('anton-review')!;
	for (const summary of ['looks fine', '```json\n{\n```', '```json\n{"passed":"false"}\n```', '```json\n{"passed":true,"checks":[{"passed":false,"severity":"error"}]}\n```', '```json\n{"passed":true,"issues":[{"severity":"blocker","category":"correctness","description":"Broken"}]}\n```']) {
		assert.equal(review.interpretAcpResult(result(summary)).success, false);
	}
	assert.equal(review.interpretAcpResult(result('```json\n{"passed":true,"checks":[],"issues":[]}\n```')).success, true);
	const security = stack.specialists.get('anton-security')!;
	assert.equal(security.interpretAcpResult(result('```json\n{broken}\n```')).success, false);
	assert.equal(security.interpretAcpResult(result('```json\n{"findings":[{"severity":"high"}]}\n```')).success, false);
});

async function routingStack(t: import('node:test').TestContext, settings: Record<string, unknown> = {}, disableAcpRouting = false) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'acp-subscription-'));
	const config = { get: <T>(key: string, fallback?: T): T => (settings[key] ?? fallback) as T };
	const llm = new LlmClient({ get: async () => { throw new Error('Unexpected direct provider call'); }, store: async () => {}, delete: async () => {} }, config);
	const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => root, onSettingChange: () => ({ dispose() {} }) });
	const stack = createAgentStack({ llmClient: llm, mcpClient: mcp, agentManager: new AgentManager(llm), globalState: { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => {} }, workspaceRoot: root, configStore: config, canUseAcp: () => true, disableAcpRouting });
	t.after(async () => { await stack.dispose(); mcp.dispose(); await rm(root, { recursive: true, force: true }); });
	return { stack, llm };
}

const claudeFixture = { id: 'claude-acp', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')] };
const taskContext = { instruction: 'Explain the current file without editing it', scopeFiles: [], graphContext: '', parentTaskId: 'plan', orchestratorModelHint: 'claude-code-opus' as const, workspaceContextSnapshot: 'Active editor: src/example.ts\nexport const answer = 42;' };
function fixtureResponse(summary: string): { text: string; model?: string } { return JSON.parse(summary.replace(/ 😀$/, '')); }

for (const mode of ['act', 'plan'] as const) {
	test(`configured specialist runtime budget cancels a direct ${mode} turn through the canonical ACP route`, { timeout: 10_000 }, async t => {
		const warnings: unknown[][] = [];
		t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
		const directory = await mkdtemp(path.join(os.tmpdir(), 'acp-configured-deadline-'));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const cancelFile = path.join(directory, 'cancelled');
		const { stack } = await routingStack(t, {
			'sota.agents.anton-code.acpAgent': 'claude-acp',
			'sota.agents.maxRuntimeMs': 150,
			'sota.acp.agents': [{ ...claudeFixture, env: { FIXTURE_MODES: '1', FIXTURE_CANCEL_FILE: cancelFile } }],
		});
		const code = stack.specialists.get('anton-code')!;
		// Separate process startup from the measured prompt, including Board's
		// read-only Plan route. The next turn relies only on the saved setting.
		await code.runAgenticTurn('warm session', () => {}, cancellation, { conversationId: mode, mode, maxRuntimeMs: 5_000 });
		const started = Date.now();
		await assert.rejects(code.runAgenticTurn('slow', () => {}, cancellation, { conversationId: mode, mode }), /deadline/);
		assert.ok(Date.now() - started < 2_000, 'configured execution budget must not use the one-hour transport ceiling');
		assert.deepEqual([await readFile(cancelFile, 'utf8'), stack.acpRuntime?.snapshot().active, warnings], ['cancelled', 0, []]);
	});
}

test('Claude specialist routing recovers after adapter configuration without rebuilding the stack', async t => {
	const settings: Record<string, unknown> = {};
	const { stack } = await routingStack(t, settings);
	const code = stack.specialists.get('anton-code')!;
	const missing = await code.execute(taskContext);
	assert.equal(missing.success, false);
	assert.match(missing.summary, /Anton: Configure Claude ACP/);
	settings['sota.acp.agents'] = [claudeFixture];
	const executed = await code.execute(taskContext);
	assert.equal(executed.success, true, executed.summary);
	const response = fixtureResponse(executed.summary);
	assert.equal(response.model, 'sonnet');
	assert.ok(response.text.includes(taskContext.workspaceContextSnapshot));
	const docs = await stack.specialists.get('anton-docs')!.execute(taskContext);
	assert.equal(docs.success, true, docs.summary);
	assert.equal(fixtureResponse(docs.summary).model, 'haiku');
});

test('chat overrides select the Claude ACP model while forced single-shot turns keep the text transport', async t => {
	const { stack, llm } = await routingStack(t, { 'sota.acp.agents': [claudeFixture] });
	const code = stack.specialists.get('anton-code')!;
	const text = await code.runAgenticTurn('Explain', () => {}, cancellation, { modelOverride: 'claude-code-opus' });
	assert.equal(fixtureResponse(text).model, 'opus');
	const requests: string[] = [];
	llm.streamRequest = async function* (options) { requests.push(options.model); yield { type: 'token', token: 'Single-shot response' }; };
	const single = await code.runAgenticTurn('Plan only', () => {}, cancellation, { modelOverride: 'claude-code-opus', forceSingleShot: true });
	assert.deepEqual({ single, requests }, { single: 'Single-shot response', requests: ['claude-code-opus'] });
});

test('a pinned direct model remains native despite a Claude orchestrator hint', async t => {
	const { stack, llm } = await routingStack(t, { 'sota.acp.agents': [claudeFixture], 'sota.agents.anton-code.model': 'sonnet' });
	const requests: string[] = [];
	llm.streamRequest = async function* (options) { requests.push(options.model); yield { type: 'token', token: 'Native result' }; };
	const executed = await stack.specialists.get('anton-code')!.execute(taskContext);
	assert.deepEqual({ success: executed.success, summary: executed.summary, requests }, { success: true, summary: 'Native result', requests: ['sonnet'] });
});

test('plan approval preserves the original editor and provider for both specialist and review', async t => {
	const { stack, llm } = await routingStack(t, { 'sota.personality.enabled': false });
	llm.streamRequest = async function* () { yield { type: 'token', token: '```json\n{"subtasks":[{"instruction":"Explain the current file","assignee":"anton-code","scopeFiles":[],"dependencies":[]}]}\n```' }; };
	const seen: { role: string; editor?: string; model?: string; maxToolCalls?: number; maxRuntimeMs?: number }[] = [];
	for (const role of ['anton-code', 'anton-review'] as const) {
		stack.specialists.get(role)!.execute = async context => {
			seen.push({ role, editor: context.workspaceContextSnapshot, model: context.orchestratorModelHint, maxToolCalls: context.maxToolCalls, maxRuntimeMs: context.maxRuntimeMs });
			return result('Reviewed explanation');
		};
	}
	const stream = { markdown: (_text: string) => {} };
	await stack.orchestrator.handleChatRequest({ prompt: 'Explain the current file', command: 'plan', maxToolCalls: 3, maxRuntimeMs: 2000, modelOverride: 'claude-code-opus', workspaceContextSnapshot: taskContext.workspaceContextSnapshot }, { history: [] }, stream, cancellation);
	await stack.orchestrator.handleChatRequest({ prompt: '', command: 'approve', workspaceContextSnapshot: 'Active editor: different-file.ts' }, { history: [] }, stream, cancellation);
	assert.deepEqual(seen, ['anton-code', 'anton-review'].map(role => ({ role, editor: taskContext.workspaceContextSnapshot, model: 'claude-code-opus', maxToolCalls: 3, maxRuntimeMs: 2000 })));
});

test('partial ACP tool updates retain completion and output', async t => {
	const { stack } = await routingStack(t, { 'sota.acp.agents': [claudeFixture] });
	const updates: { name: string; status: string; output?: string }[] = [];
	await stack.specialists.get('anton-code')!.runAgenticTurn('partial-tool-updates', event => {
		if (event.type === 'tool-call') { updates.push({ name: event.name, status: event.status, output: event.output }); }
	}, cancellation, { modelOverride: 'claude-code-sonnet' });
	assert.deepEqual(updates, [
		{ name: 'Read file', status: 'running', output: undefined },
		{ name: 'Read file', status: 'done', output: '"First heading"' },
		{ name: 'Read README.md', status: 'done', output: '"First heading"' },
	]);
});

test('ACP server stacks disable both automatic and explicit adapter routing', async t => {
	const { stack, llm } = await routingStack(t, {
		'sota.acp.agents': [claudeFixture], 'sota.agents.anton-code.model': 'claude-code-sonnet',
		'sota.agents.anton-code.acpAgent': 'claude-acp',
	}, true);
	const requests: string[] = [];
	llm.streamRequest = async function* (options) { requests.push(options.model); yield { type: 'token', token: 'Native server response' }; };
	const code = await stack.specialists.get('anton-code')!.runAgenticTurn('Explain', () => {}, cancellation);
	const docs = await stack.specialists.get('anton-docs')!.runAgenticTurn('Explain', () => {}, cancellation, { modelOverride: 'claude-code-haiku' });
	assert.deepEqual({ code, docs, requests }, { code: 'Native server response', docs: 'Native server response', requests: ['claude-code-sonnet', 'claude-code-haiku'] });
});


test('native catalog selections override specialist ACP pins and preserve exact native routing', async t => {
	const id = discoveredModelId('openai', 'gpt-4.1-native-route');
	registerDiscoveredModels([{ id, provider: 'openai', model: 'gpt-4.1-native-route', label: 'Native route', chat: true, images: true, tools: false, fetchedAt: 1 }]);
	const { stack, llm } = await routingStack(t, { 'sota.agents.anton-code.acpAgent': 'claude-acp', 'sota.acp.agents': [claudeFixture] });
	const calls: string[] = [];
	t.mock.method(llm, 'streamRequest', async function* (options: { model: string }) { calls.push(options.model); yield { type: 'token' as const, token: 'Native catalog response' }; });
	const code = stack.specialists.get('anton-code')!;
	const text = await code.runChatTurn('Explain', () => {}, cancellation, { modelOverride: id });
	await stack.specialists.get('anton-docs')!.execute({ ...taskContext, orchestratorModelHint: id });
	assert.deepEqual([text, calls, code.getExecutionCapabilities(id).transport, stack.acpRuntime?.snapshot().processes], ['Native catalog response', [id, id], 'native', 0]);
});

test('orchestrator runtime budget cancels its native provider stream', async t => {
	const { stack, llm } = await routingStack(t);
	let observed: AbortSignal | undefined;
	t.mock.method(llm, 'streamRequest', async function* (options: { signal?: AbortSignal }) {
		observed = options.signal;
		await new Promise<void>(resolve => { if (options.signal?.aborted) { resolve(); } else { options.signal?.addEventListener('abort', () => resolve(), { once: true }); } });
		options.signal?.throwIfAborted();
		yield { type: 'token' as const, token: 'Should never render' };
	});
	let output = '';
	await stack.orchestrator.handleChatRequest({ prompt: 'hello', maxRuntimeMs: 20 }, { history: [] }, { markdown: text => { output += text; } }, cancellation);
	assert.deepEqual([observed?.aborted, output.includes('Should never render')], [true, false]);
});


test('profile model pins update existing specialists without rebuilding their agent stack', async t => {
	const id = discoveredModelId('openai', 'gpt-4.1-profile-hint');
	registerDiscoveredModels([{ id, provider: 'openai', model: 'gpt-4.1-profile-hint', label: 'Profile hint', chat: true, images: true, tools: false, fetchedAt: 1 }]);
	const settings: Record<string, unknown> = {};
	const { stack, llm } = await routingStack(t, settings);
	const calls: string[] = [];
	t.mock.method(llm, 'streamRequest', async function* (options: { model: string }) { calls.push(options.model); yield { type: 'token' as const, token: 'Documented' }; });
	const docs = stack.specialists.get('anton-docs')!;
	await docs.execute({ ...taskContext, orchestratorModelHint: id });
	settings['sota.agents.anton-docs.model'] = 'gpt-4o';
	await docs.execute({ ...taskContext, orchestratorModelHint: id });
	settings['sota.agents.anton-docs.model'] = 'gpt-4o-mini';
	await docs.runChatTurn('Explain', () => {}, cancellation);
	await docs.runChatTurn('Explicit picker wins', () => {}, cancellation, { modelOverride: id });
	delete settings['sota.agents.anton-docs.model'];
	await docs.execute({ ...taskContext, orchestratorModelHint: id });
	assert.deepEqual(calls, [id, 'gpt-4o', 'gpt-4o-mini', id, id]);
});
