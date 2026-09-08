/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderDiscovery } from './ProviderDiscovery';
import { discoveredModelId, getDiscoveredModel, registerDiscoveredModels } from './DiscoveredModels';
import { LlmClient, isOpenAIReasoningModel, providerForModel, supportsAgenticToolLoop, modelSupportsImages } from './LlmClient';

const emptySecrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
const config = (values: Record<string, unknown> = {}) => ({ get: <T>(key: string, fallback?: T): T => (values[key] ?? fallback) as T });
async function fixture(t: import('node:test').TestContext) {
	const home = await mkdtemp(path.join(os.tmpdir(), 'sota-provider-discovery-'));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

test('software discovery reads documented model fields without running tools or returning credentials', async t => {
	const home = await fixture(t); const bin = path.join(home, 'bin');
	await mkdir(bin); await mkdir(path.join(home, '.claude'));
	await writeFile(path.join(bin, 'claude'), '#!/bin/sh\nprintf DO_NOT_EXECUTE'); await chmod(path.join(bin, 'claude'), 0o700);
	await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_API_KEY: 'fixture-private-key' } }));
	await writeFile(path.join(home, '.claude/.credentials.json'), 'private-auth-payload');
	let calls = 0;
	const finder = new ProviderDiscovery({ home, env: { PATH: bin }, secrets: emptySecrets, config: config(), request: async () => { calls++; throw new Error('Must not request without configured credentials'); } });
	t.after(() => finder.dispose());
	const snapshot = await finder.refresh();
	const claude = snapshot.software.find(software => software.id === 'claude')!;
	assert.deepEqual([claude.installed, claude.auth, claude.configuredModels, calls], [true, 'file-present', ['sonnet'], 0]);
	assert.ok(!JSON.stringify(snapshot).includes('fixture-private-key') && !JSON.stringify(snapshot).includes('private-auth-payload'));
	assert.equal(snapshot.providers.find(provider => provider.id === 'copilot')?.catalogStatus, 'extension-required');
});

test('Anthropic catalogs page to completion and keep capabilities and credential scope separate', async t => {
	const home = await fixture(t); const urls: URL[] = [];
	const finder = new ProviderDiscovery({ home, env: { PATH: '', ANTHROPIC_API_KEY: 'fixture-key' }, secrets: emptySecrets, config: config(), request: async (input, init) => {
		const url = new URL(String(input)); urls.push(url);
		assert.equal(new Headers(init?.headers).get('x-api-key'), 'fixture-key');
		return Response.json(url.searchParams.has('after_id') ? { data: [{ id: 'claude-next', display_name: 'Next Claude' }], has_more: false } : { data: [{ id: 'claude-vision', display_name: 'Vision Claude', capabilities: { image_input: { supported: true } }, max_input_tokens: 200000 }], has_more: true, last_id: 'claude-vision' });
	} });
	t.after(() => finder.dispose());
	const snapshot = await finder.refresh(); const provider = snapshot.providers.find(provider => provider.id === 'anthropic')!;
	assert.deepEqual([urls.length, urls[1].searchParams.get('after_id'), provider.catalogStatus, provider.inferenceStatus, provider.models.length], [2, 'claude-vision', 'ready', 'not-tested', 2]);
	assert.equal(provider.models.find(model => model.model === 'claude-vision')?.images, true);
	await finder.refresh(); assert.equal(urls.length, 2);
});

test('catalog failures retain cached models and expose only a redacted status', async t => {
	const home = await fixture(t); let fail = false;
	const finder = new ProviderDiscovery({ home, env: { PATH: '', OPENAI_API_KEY: 'fixture-key' }, secrets: emptySecrets, config: config(), request: async () => fail ? new Response('secret-and-error-body', { status: 401 }) : Response.json({ data: [{ id: 'gpt-new' }] }) });
	t.after(() => finder.dispose());
	await finder.refresh(); fail = true;
	const snapshot = await finder.refresh({ force: true }); const provider = snapshot.providers.find(provider => provider.id === 'openai')!;
	assert.deepEqual([provider.catalogStatus, provider.models.map(model => model.model)], ['error', ['gpt-new']]);
	assert.ok(!JSON.stringify(snapshot).includes('secret-and-error-body'));
});

test('local servers require opt-in and map advertised local capabilities', async t => {
	const home = await fixture(t); const urls: string[] = [];
	const finder = new ProviderDiscovery({ home, env: { PATH: '' }, secrets: emptySecrets, config: config(), request: async input => {
		const url = String(input); urls.push(url);
		return Response.json(url.includes('11434') ? { models: [{ name: 'coding-model:latest' }] } : { models: [{ key: 'local/vision-coder', display_name: 'Local Vision', type: 'llm', capabilities: { vision: true, trained_for_tool_use: true } }] });
	} });
	t.after(() => finder.dispose());
	await finder.refresh(); assert.deepEqual(urls, []);
	const snapshot = await finder.refresh({ force: true, includeLocal: true });
	assert.deepEqual(urls.sort(), ['http://localhost:11434/api/tags', 'http://localhost:1234/api/v1/models']);
	assert.equal(snapshot.providers.find(provider => provider.id === 'lmstudio')?.models[0].tools, true);
});

test('configured Azure/Bedrock models remain selectable and explain management catalog limits', async t => {
	const home = await fixture(t);
	const finder = new ProviderDiscovery({ home, env: { PATH: '' }, secrets: emptySecrets, config: config({ foundryDeployments: '{"foundry-custom":"my-deployment"}', bedrockModelMap: '{"bedrock-custom":"anthropic.claude-custom-v1:0"}' }) });
	t.after(() => finder.dispose());
	const snapshot = await finder.refresh();
	for (const id of ['foundry', 'bedrock']) {
		const provider = snapshot.providers.find(provider => provider.id === id)!;
		assert.equal(provider.catalogStatus, 'configuration-only'); assert.equal(provider.models.length, 1);
		assert.match(provider.catalogScope!, /management access/);
	}
});

test('registered model IDs preserve raw provider names and never assume unknown capabilities', () => {
	const id = discoveredModelId('openai', 'gpt-5.99-special');
	registerDiscoveredModels([{ id, provider: 'openai', model: 'gpt-5.99-special', label: 'Custom GPT', chat: true, images: 'unknown', tools: 'unknown', fetchedAt: 1 }]);
	const llm = new LlmClient(emptySecrets, config());
	assert.deepEqual([providerForModel(id), llm.getModelId(id), supportsAgenticToolLoop(id), modelSupportsImages(id), isOpenAIReasoningModel(id)], ['openai', 'gpt-5.99-special', false, false, true]);
	assert.throws(() => providerForModel(discoveredModelId('openai', 'not-registered')), /Refresh/);
});

test('discovered model inference uses the exact provider wire ID and normal response transport', async t => {
	const id = discoveredModelId('openai', 'gpt-4.1-new-fixture');
	registerDiscoveredModels([{ id, provider: 'openai', model: 'gpt-4.1-new-fixture', label: 'New fixture', chat: true, images: false, tools: false, fetchedAt: 1 }]);
	const requests: Record<string, unknown>[] = [];
	t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
		requests.push(JSON.parse(String(init.body)));
		return new Response('data: {"choices":[{"delta":{"content":"working"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
	});
	const llm = new LlmClient(emptySecrets, config({ openaiApiKey: 'fixture-key' }));
	let response = '';
	for await (const event of llm.streamRequest({ model: id, messages: [{ role: 'user', content: 'hello' }] })) { if (event.type === 'token') { response += event.token; } }
	assert.deepEqual([response, requests[0].model, getDiscoveredModel(id)?.pricing], ['working', 'gpt-4.1-new-fixture', undefined]);
});


test('selected model tool verification makes one bounded synthetic request and caches observed support', async t => {
	const id = discoveredModelId('openai', 'gpt-4.1-probe-fixture');
	registerDiscoveredModels([{ id, provider: 'openai', model: 'gpt-4.1-probe-fixture', label: 'Probe', chat: true, images: 'unknown', tools: 'unknown', fetchedAt: 1 }]);
	const requests: Record<string, unknown>[] = [];
	t.mock.method(globalThis, 'fetch', async (_input: string, init: RequestInit) => {
		requests.push(JSON.parse(String(init.body)));
		const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic', function: { name: 'sota_discovery_echo', arguments: JSON.stringify({ text: 'son-of-anton-probe' }) } }] }, finish_reason: 'tool_calls' }] };
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
	});
	const llm = new LlmClient(emptySecrets, config({ openaiApiKey: 'fixture-key' }));
	const result = await llm.verifyDiscoveredModel(id);
	const observed = getDiscoveredModel(id)!;
	assert.deepEqual([result.verified, requests.length, requests[0].max_tokens, observed.tools, observed.images, observed.capabilitySource, supportsAgenticToolLoop(id)], [true, 1, 256, true, 'unknown', 'verified', true]);
	assert.ok(observed.verifiedAt);
});

test('failed model capability probes do not retry or promote unknown support', async t => {
	const id = discoveredModelId('openai', 'gpt-4.1-probe-failure');
	registerDiscoveredModels([{ id, provider: 'openai', model: 'gpt-4.1-probe-failure', label: 'Failure', chat: true, images: 'unknown', tools: 'unknown', fetchedAt: 1 }]);
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('private-provider-details', { status: 503 }); });
	const result = await new LlmClient(emptySecrets, config({ openaiApiKey: 'fixture-key' })).verifyDiscoveredModel(id);
	assert.deepEqual([result.verified, requests, getDiscoveredModel(id)?.tools, result.message.includes('private-provider-details')], [false, 1, 'unknown', false]);
});

test('older LM Studio catalog fallback retains unknown capabilities', async t => {
	const home = await fixture(t); const urls: string[] = [];
	const finder = new ProviderDiscovery({ home, env: { PATH: '' }, secrets: emptySecrets, config: config(), request: async input => {
		const url = String(input); urls.push(url);
		if (url.includes('11434')) { return Response.json({ models: [] }); }
		return url.endsWith('/api/v1/models') ? new Response('', { status: 404 }) : Response.json({ data: [{ id: 'old-studio-model' }] });
	} });
	t.after(() => finder.dispose());
	const provider = (await finder.refresh({ includeLocal: true })).providers.find(provider => provider.id === 'lmstudio')!;
	assert.deepEqual([provider.catalogStatus, provider.models[0].tools, provider.models[0].chat, urls.includes('http://localhost:1234/v1/models')], ['ready', 'unknown', 'unknown', true]);
});


test('mixed native model and adapter accounting preserves estimates and marks unknown billing', async t => {
	const priced = discoveredModelId('openai', 'gpt-4.1-priced');
	const unknown = discoveredModelId('openai', 'gpt-4.1-unpriced');
	registerDiscoveredModels([
		{ id: priced, provider: 'openai', model: 'gpt-4.1-priced', label: 'Priced', chat: true, images: false, tools: false, fetchedAt: 1, pricing: { inputPerMillion: 2, outputPerMillion: 8 } },
		{ id: unknown, provider: 'openai', model: 'gpt-4.1-unpriced', label: 'Unknown', chat: true, images: false, tools: false, fetchedAt: 1 },
	]);
	t.mock.method(globalThis, 'fetch', async () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
	const llm = new LlmClient(emptySecrets, config({ openaiApiKey: 'fixture-key' }));
	for (const model of [priced, unknown]) { for await (const _event of llm.streamRequest({ model, messages: [{ role: 'user', content: 'hello' }] })) { /* Drain provider response. */ } }
	llm.recordUnmeteredRequest();
	assert.deepEqual(llm.getAccountingUsage(), { requests: 3, unmeteredRequests: 2, estimatedCostUsd: 0.0006 });
	assert.equal(Number.isFinite(llm.estimateCost(priced)), true);
});


test('additional coding providers discover real catalogs and keep Z.AI configured IDs explicit', async t => {
	const home = await fixture(t); const urls: string[] = [];
	const finder = new ProviderDiscovery({ home, env: { PATH: '', XAI_API_KEY: 'fixture', MOONSHOT_API_KEY: 'fixture', MINIMAX_API_KEY: 'fixture', ZAI_API_KEY: 'fixture' }, secrets: emptySecrets, config: config({ zaiModels: ['glm-user-deployment'] }), request: async input => { urls.push(String(input)); return Response.json({ data: [{ id: 'provider-coding-model', supports_image_in: true }] }); } });
	t.after(() => finder.dispose());
	const snapshot = await finder.refresh();
	assert.deepEqual(urls.sort(), ['https://api.minimax.io/v1/models', 'https://api.moonshot.ai/v1/models', 'https://api.x.ai/v1/models']);
	const zai = snapshot.providers.find(provider => provider.id === 'zai')!;
	assert.deepEqual([zai.catalogStatus, zai.models.map(model => model.model), snapshot.providers.find(provider => provider.id === 'moonshot')?.models[0].images], ['catalog-unavailable', ['glm-user-deployment'], true]);
});
