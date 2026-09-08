/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createAgentStack } from './AgentStackFactory';
import { AgentManager } from './AgentManager';
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
