/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BedrockRuntimeClient, type InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { discoveredModelId, registerDiscoveredModels } from './DiscoveredModels';
import { LlmClient, supportsAgenticToolLoop, type ModelId } from './LlmClient';
import { BaseAgent } from '../agents/BaseAgent';
import { AgentManager } from '../agents/AgentManager';
import { MetricsTracker } from '../agents/MetricsTracker';
import { ProjectMemory } from '../agents/ProjectMemory';
import { McpClient } from '../mcp/McpClient';
import type { ConfigStore, SecretStore } from '../host';
import { applyImageCapability, parseToolArguments } from './messageSerialization';

class FixtureAgent extends BaseAgent {
	protected getRoleDescription(): string { return 'Offline fixture'; }
	async execute(): Promise<never> { throw new Error('Use drive'); }
	drive(model: ModelId, execute: (input: Record<string, unknown>) => void, signal?: AbortSignal) {
		return this.runToolLoop({ taskId: 'fixture', model, systemPrompt: 'Use read_fixture, then finish.', initialMessages: [{ role: 'user', content: 'Read fixture.txt' }], tools: [{ name: 'read_fixture', description: 'Read the offline fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }], maxIterations: 3, signal, executeTool: async call => { execute(call.input); return { result: 'fixture content' }; } });
	}
}

function frames(protocol: 'anthropic' | 'openai' | 'google', turn: number): object[] {
	const input = '{"path":"fixture.txt"}';
	if (protocol === 'anthropic') {
		return [
			{ type: 'message_start', message: { usage: { input_tokens: 100 } } },
			...(turn === 1 ? [
				{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'read_fixture' } },
				{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } },
				{ type: 'content_block_stop', index: 0 },
			] : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished' } }]),
			{ type: 'message_delta', delta: { stop_reason: turn === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
		];
	}
	if (protocol === 'google') {
		return [{ candidates: [{ content: { parts: turn === 1 ? [{ functionCall: { name: 'read_fixture', args: { path: 'fixture.txt' } }, thoughtSignature: 'fixture-signature' }] : [{ text: 'Finished' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } }];
	}
	return [{ choices: [{ delta: turn === 1 ? { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_fixture', arguments: input } }] } : { content: 'Finished' }, finish_reason: turn === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } }];
}

const additionalModels = (['xai', 'moonshot', 'zai', 'minimax'] as const).map(provider => {
	const id = discoveredModelId(provider, `${provider}-coding-fixture`);
	registerDiscoveredModels([{ id, provider, model: `${provider}-coding-fixture`, label: provider, tools: true, images: 'unknown', chat: true, fetchedAt: 1 }]);
	return id;
});
const models: ModelId[] = ['sonnet', 'gpt-4o', 'foundry-gpt-4o', 'bedrock-claude-sonnet-4', 'gemini-2-5-pro', 'openrouter-gpt-5', 'ollama-llama-3-1', 'lmstudio-loaded', 'deepseek-v3', 'mistral-large', 'groq-llama-3-3-70b', 'cerebras-llama-3-3-70b', 'together-qwen-2-5-coder', 'fireworks-deepseek-v3'];

for (const model of [...models, ...additionalModels]) {
	test(`${model}: shared agent executes a two-turn tool contract with correct usage`, async t => {
		const bodies: Array<Record<string, unknown>> = [];
		const protocol = model === 'sonnet' || model.startsWith('bedrock') ? 'anthropic' : model.startsWith('gemini') ? 'google' : 'openai';
		const reply = (body: Record<string, unknown>) => { bodies.push(body); const response = frames(protocol, bodies.length); if (model.startsWith('catalog:moonshot:') && bodies.length === 1) { (response[0] as { choices: Array<{ delta: { reasoning_content?: string } }> }).choices[0].delta.reasoning_content = 'Fixture provider reasoning'; } return response; };
		t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
			const response = reply(JSON.parse(String(init?.body)));
			return new Response(response.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
		});
		t.mock.method(BedrockRuntimeClient.prototype, 'send', async (command: InvokeModelWithResponseStreamCommand) => {
			const response = reply(JSON.parse(new TextDecoder().decode(command.input.body as Uint8Array)));
			return { body: (async function* () { for (const frame of response) { yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(frame)) } }; } })() };
		});
		const settings: Record<string, unknown> = { foundryEndpoint: 'https://fixture.invalid', foundryDeployments: JSON.stringify({ 'foundry-gpt-4o': 'fixture' }), bedrockRegion: 'us-east-1' };
		const config: ConfigStore = { get: <T>(key: string, fallback?: T): T => (settings[key] ?? fallback) as T };
		const secrets: SecretStore = { get: async () => 'synthetic-fixture-key', store: async () => {}, delete: async () => {} };
		const llm = new LlmClient(secrets, config);
		const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => undefined, onSettingChange: () => ({ dispose() {} }) });
		t.after(() => mcp.dispose());
		const agent = new FixtureAgent({ handle: 'anton-code', displayName: 'Fixture', description: 'Fixture', defaultModel: model, maxRetries: 0, slashCommands: [] }, llm, mcp, new AgentManager(llm), new MetricsTracker(), new ProjectMemory());
		const executed: Record<string, unknown>[] = [];
		const result = await agent.drive(model, input => executed.push(input));
		assert.deepEqual({ text: result.text, iterations: result.iterations, executed, inputTokens: result.tokenUsage.inputTokens, outputTokens: result.tokenUsage.outputTokens }, { text: 'Finished', iterations: 2, executed: [{ path: 'fixture.txt' }], inputTokens: 200, outputTokens: 20 });
		assert.equal(bodies.length, 2);
		assert.ok(bodies.every(body => Array.isArray(body.tools) && body.tools.length === 1));
		if (protocol === 'openai') {
			const messages = bodies[1].messages as Array<{ role: string; tool_call_id?: string; content: string }>;
			assert.deepEqual(messages.find(message => message.role === 'tool'), { role: 'tool', tool_call_id: 'call-1', content: 'fixture content' });
		} else if (protocol === 'google') {
			assert.match(JSON.stringify(bodies[1].contents), /fixture-signature/);
			assert.match(JSON.stringify(bodies[1].contents), /functionResponse/);
		}
		if (model.startsWith('catalog:moonshot:')) { assert.match(JSON.stringify(bodies[1].messages), /reasoning_content.*Fixture provider reasoning/); }
		assert.equal(supportsAgenticToolLoop(model), true);
	});
}

test('malformed tool arguments fail closed and image filtering preserves tool results', () => {
	assert.throws(() => parseToolArguments('[', 'write_file'), /malformed/);
	assert.throws(() => parseToolArguments('[]', 'write_file'), /non-object/);
	const parts = applyImageCapability([{ type: 'image', mimeType: 'image/png', base64Data: 'fixture' }, { type: 'tool_result', tool_use_id: 'call', content: 'keep' }], false);
	assert.equal(parts[0].type, 'tool_result');
});

test('subscription text transports reject host tool requests before launching their CLI', async () => {
	const secrets: SecretStore = { get: async () => { throw new Error('Must fail before credential lookup'); }, store: async () => {}, delete: async () => {} };
	const llm = new LlmClient(secrets, { get: <T>(_key: string, fallback?: T) => fallback as T });
	for (const model of ['claude-code-sonnet', 'codex-gpt-5'] as ModelId[]) {
		const events = [];
		for await (const event of llm.streamRequest({ model, systemPrompt: 'Fixture', messages: [{ role: 'user', content: 'Read fixture' }], tools: [{ name: 'read_fixture', description: 'Read fixture', inputSchema: { type: 'object', properties: {} } }] })) { events.push(event); }
		assert.ok(events.some(event => event.type === 'error' && /text transport cannot execute host tools/.test(event.error)));
	}
});


test('native specialist Plan turns preserve images while exposing no executable tools', async t => {
	const requests: Array<Record<string, unknown>> = [];
	t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
		requests.push(JSON.parse(String(init?.body)));
		return new Response(frames('openai', 2).map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
	});
	const config: ConfigStore = { get: <T>(key: string, fallback?: T): T => (key === 'personality.enabled' ? false : fallback) as T };
	const secrets: SecretStore = { get: async () => 'synthetic-fixture-key', store: async () => {}, delete: async () => {} };
	const llm = new LlmClient(secrets, config);
	const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => undefined, onSettingChange: () => ({ dispose() {} }) });
	t.after(() => mcp.dispose());
	const forbidden = async (): Promise<never> => { throw new Error('Plan must not call host tools'); };
	const agent = new FixtureAgent({ handle: 'anton-code', displayName: 'Fixture', description: 'Fixture', defaultModel: 'gpt-4o', maxRetries: 0, slashCommands: [] }, llm, mcp, new AgentManager(llm), new MetricsTracker(), new ProjectMemory(), undefined, config, undefined, { workspaceRoot: undefined, readFile: forbidden, readDir: forbidden, searchTextInWorkspace: forbidden, writeFile: forbidden, runCommand: forbidden });
	const cancel = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
	const response = await agent.runAgenticTurn('Explain this image', () => {}, cancel, { mode: 'plan', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] });
	assert.deepEqual([response, requests.length, requests[0].tools], ['Finished', 1, undefined]);
	assert.match(JSON.stringify(requests[0].messages), /data:image\/png;base64,aGVsbG8=/);
	assert.match(JSON.stringify(requests[0].messages), /Plan mode/);
	await assert.rejects(agent.runAgenticTurn('Unsupported image', () => {}, cancel, { mode: 'plan', modelOverride: 'deepseek-v3', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] }), /does not support image attachments/);
	assert.equal(requests.length, 1);
});
