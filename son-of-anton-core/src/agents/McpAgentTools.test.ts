/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAgentStack } from './AgentStackFactory';
import { AgentManager } from './AgentManager';
import { LlmClient, type LlmRequestOptions, type LlmStreamEvent } from '../llm/LlmClient';
import { McpClient } from '../mcp/McpClient';
import { bridgeMcpToolsIntoRegistry } from '../mcp/McpToolBridge';
import { ToolRegistry } from '../tools/registry';
import type { ToolExecutionContext } from '../tools/types';
import type { CancellationLike } from '../chatStream';

const cancellation: CancellationLike = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const schema = { type: 'object', properties: { value: { type: 'string', minLength: 1 } }, required: ['value'], additionalProperties: false };

class ToolCallingModel extends LlmClient {
	override async *streamRequest(options: LlmRequestOptions): AsyncGenerator<LlmStreamEvent> {
		assert.deepEqual(options.tools?.find(tool => tool.name === 'mcp__fixture__mutate')?.inputSchema, schema);
		const last = options.messages.at(-1)?.content;
		if (Array.isArray(last) && last[0]?.type === 'tool_result') {
			yield { type: 'token', token: String(last[0].content) };
		} else {
			yield { type: 'tool-call', id: 'test-call', name: 'mcp__fixture__mutate', input: { value: 'hello' } };
		}
	}
}

function client(): McpClient {
	return new McpClient({ readServersSetting: () => [{ name: 'fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/mcp-tools.cjs')] }], getWorkspaceRoot: () => undefined, onSettingChange: () => ({ dispose() {} }) });
}

describe('MCP tools in native agent loops', () => {
	for (const entry of ['chat', 'specialist'] as const) {
		test(`${entry} preserves schemas and gates external side effects`, async t => {
			const config = { get: <T>(_key: string, fallback?: T) => fallback as T };
			const llm = new ToolCallingModel({ get: async () => undefined, store: async () => {}, delete: async () => {} }, config);
			const mcp = client();
			let approved = false;
			let approvals = 0;
			const ctx: ToolExecutionContext = {
				workspaceRoot: undefined, readFile: async () => '', readDir: async () => [], searchTextInWorkspace: async () => [],
				writeFile: async () => ({ written: false }), runCommand: async () => ({ ran: false }),
				requestMcpApproval: async () => { approvals++; return approved; },
			};
			const stack = createAgentStack({ llmClient: llm, mcpClient: mcp, agentManager: new AgentManager(llm), globalState: { get: config.get, update: async () => {} }, workspaceRoot: undefined, toolExecutionContext: ctx });
			t.after(async () => { await stack.dispose(); mcp.dispose(); });
			const agent = stack.specialists.get('anton-code')!;
			const run = async () => entry === 'chat'
				? agent.runAgenticTurn('use the tool', () => {}, cancellation)
				: (await agent.execute({ instruction: 'use the tool', scopeFiles: [], graphContext: '', parentTaskId: 'parent' })).summary;
			assert.match(await run(), /not approved/);
			approved = true;
			assert.match(await run(), /accepted:hello/);
			assert.equal(approvals, 2);
		});
	}
	test('cancellation reaches the MCP server and leaves its connection reusable', async t => {
		const mcp = client();
		t.after(() => mcp.dispose());
		const listing = await mcp.listTools();
		assert.deepEqual(listing[0].inputSchema, schema);
		const controller = new AbortController();
		const pending = mcp.callTool({ server: 'fixture', tool: 'wait', inputs: { value: 'hello' }, signal: controller.signal });
		// Let callTool pass its asynchronous initialization boundary and send tools/call.
		await new Promise<void>(resolve => setImmediate(resolve));
		controller.abort();
		await assert.rejects(pending, /cancelled/);
		assert.equal((await mcp.callTool({ server: 'fixture', tool: 'status', inputs: {} })).content, '1');
	});
	test('missing approval handlers and approval arriving after cancellation cannot execute MCP tools', async t => {
		const mcp = client();
		t.after(() => mcp.dispose());
		const registry = new ToolRegistry([]);
		await bridgeMcpToolsIntoRegistry(mcp, registry, { requireApproval: true });
		const ctx = {} as ToolExecutionContext;
		assert.match((await registry.execute('mcp__fixture__mutate', { value: 'hello' }, ctx)).content, /not approved/);
		const controller = new AbortController();
		const result = await registry.execute('mcp__fixture__mutate', { value: 'hello' }, {
			...ctx, signal: controller.signal, requestMcpApproval: async () => { controller.abort(); return true; },
		});
		assert.equal(result.isError, true);
		assert.doesNotMatch(result.content, /accepted:/);
	});
});
