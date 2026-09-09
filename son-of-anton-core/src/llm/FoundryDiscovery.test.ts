/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MementoStore } from '../host';
import { ProviderDiscovery, type ProviderDiscoverySnapshot } from './ProviderDiscovery';
import { discoveredModelId, getDiscoveredModel, markDiscoveredToolsVerified, registerDiscoveredModels, replaceDiscoveredModels, type DiscoveredModel } from './DiscoveredModels';
import { LlmClient, type ModelId } from './LlmClient';

async function fixture(t: TestContext, deployments: Record<string, string>) {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-foundry-family-'));
	const values: Record<string, string> = { foundryDeployments: JSON.stringify(deployments), foundryEndpoint: 'https://foundry-fixture.invalid', foundryApiKey: 'fixture-key', reasoningEffort: 'high' };
	const config = { get: <T>(key: string, fallback?: T): T => (values[key] ?? fallback) as T };
	const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
	const saved = new Map<string, ProviderDiscoverySnapshot>();
	const state: MementoStore = { get: <T>(key: string, fallback?: T) => (saved.get(key) ?? fallback) as T, update: async (key, value) => { saved.set(key, structuredClone(value) as ProviderDiscoverySnapshot); } };
	const instances: ProviderDiscovery[] = [];
	const create = () => {
		const finder = new ProviderDiscovery({ config, secrets, state, home, env: { PATH: '' }, request: async () => { throw new Error('Configured deployment discovery must not request provider APIs'); } });
		instances.push(finder); return finder;
	};
	const requests: { url: URL; body: Record<string, unknown> }[] = [];
	t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: new URL(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body)) });
		return new Response('data: {"choices":[{"delta":{"content":"working"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
	});
	const llm = new LlmClient(secrets, config);
	const infer = async (model: ModelId) => {
		let text = '';
		for await (const event of llm.streamRequest({ model, messages: [{ role: 'user', content: 'hello' }], maxTokens: 123 })) {
			assert.notEqual(event.type, 'error', JSON.stringify(event));
			if (event.type === 'token') { text += event.token; }
		}
		assert.equal(text, 'working');
		return requests.at(-1)!;
	};
	t.after(async () => { for (const finder of instances) { finder.dispose(); } replaceDiscoveredModels({ provider: 'foundry' }, []); await rm(home, { recursive: true, force: true }); });
	return { values, saved, create, infer };
}

for (const family of ['foundry-gpt-5', 'foundry-gpt-5-mini', 'foundry-o1-mini', 'foundry-o3', 'foundry-o4-mini', 'foundry-gpt-4o', 'foundry-custom'] as const) {
	test(`${family} preserves request semantics through discovery without inferring them from an opaque deployment name`, async t => {
		const f = await fixture(t, { [family]: 'my-deployment' });
		if (family === 'foundry-gpt-4o') { f.values.foundryApiVersion = '2024-06-01'; }
		const finder = f.create(); await finder.refresh();
		const id = discoveredModelId('foundry', 'my-deployment');
		const metadata = getDiscoveredModel(id)!;
		assert.deepEqual({ family: metadata.modelFamily, wire: metadata.model, tools: metadata.tools, images: metadata.images }, { family, wire: 'my-deployment', tools: 'unknown', images: 'unknown' });
		const reasoning = !['foundry-gpt-4o', 'foundry-custom'].includes(family);
		for (const model of [family, id]) {
			const { url, body } = await f.infer(model);
			assert.deepEqual(url, new URL(`https://foundry-fixture.invalid/openai/deployments/my-deployment/chat/completions?api-version=${f.values.foundryApiVersion ?? '2024-10-01-preview'}`));
			assert.deepEqual({ completion: body.max_completion_tokens, classic: body.max_tokens, effort: body.reasoning_effort }, reasoning
				? { completion: 123, classic: undefined, effort: family === 'foundry-o1-mini' ? undefined : 'high' }
				: { completion: undefined, classic: 123, effort: undefined });
			if (model === id) { assert.equal(body.model, 'my-deployment'); }
		}
	});
}

test('mapped GPT-5 dot versions retain reasoning semantics without matching GPT-50 and auto effort is omitted', async t => {
	const f = await fixture(t, { 'foundry-gpt-5.1': 'versioned-deployment', 'foundry-gpt-50': 'unrelated-family' });
	const finder = f.create(); await finder.refresh();
	f.values.reasoningEffort = 'auto';
	const versioned = (await f.infer(discoveredModelId('foundry', 'versioned-deployment'))).body;
	const unrelated = (await f.infer(discoveredModelId('foundry', 'unrelated-family'))).body;
	assert.deepEqual([versioned.max_completion_tokens, versioned.max_tokens, versioned.reasoning_effort, unrelated.max_completion_tokens, unrelated.max_tokens, unrelated.reasoning_effort], [123, undefined, undefined, undefined, 123, undefined]);
});

test('persisted Foundry family survives hydration and invalid configuration, then updates without stale verified capabilities', async t => {
	const f = await fixture(t, { 'foundry-gpt-5': 'my-deployment' });
	const finder = f.create(); await finder.refresh();
	const id = discoveredModelId('foundry', 'my-deployment');
	markDiscoveredToolsVerified(id); await finder.captureAdvertisedModels(); finder.dispose();
	const cached = f.saved.get('sota.providerDiscovery.v1')!.providers.find(provider => provider.id === 'foundry')!.models[0];
	assert.equal(cached.modelFamily, 'foundry-gpt-5');
	cached.label = 'foundry-gpt-4o · misleading display label';
	replaceDiscoveredModels({ provider: 'foundry' }, []);
	f.values.foundryDeployments = '{broken';
	t.mock.method(console, 'warn', () => {});
	const reopened = f.create();
	assert.deepEqual([getDiscoveredModel(id)?.modelFamily, getDiscoveredModel(id)?.tools], ['foundry-gpt-5', true]);
	assert.equal((await f.infer(id)).body.max_completion_tokens, 123);
	f.values.foundryDeployments = JSON.stringify({ 'foundry-gpt-4o': 'my-deployment' });
	await reopened.refresh({ force: true });
	const updated = getDiscoveredModel(id)!;
	assert.deepEqual({ family: updated.modelFamily, tools: updated.tools, verifiedAt: updated.verifiedAt, body: (await f.infer(id)).body.max_completion_tokens }, { family: 'foundry-gpt-4o', tools: 'unknown', verifiedAt: undefined, body: undefined });
});

test('legacy Foundry cache obtains model family from current configuration, never from the deployment name or label', async t => {
	const f = await fixture(t, { 'foundry-custom': 'foundry-gpt-5' });
	const finder = f.create(); await finder.refresh(); finder.dispose();
	const cached = f.saved.get('sota.providerDiscovery.v1')!.providers.find(provider => provider.id === 'foundry')!.models[0];
	delete cached.modelFamily; cached.label = 'foundry-o3';
	replaceDiscoveredModels({ provider: 'foundry' }, []);
	const reopened = f.create();
	const id = discoveredModelId('foundry', 'foundry-gpt-5');
	assert.equal(reopened.snapshot().providers.find(provider => provider.id === 'foundry')!.models[0].modelFamily, 'foundry-custom');
	const body = (await f.infer(id)).body;
	assert.deepEqual([body.model, body.max_tokens, body.max_completion_tokens, body.reasoning_effort], ['foundry-gpt-5', 123, undefined, undefined]);
});

test('catalog registration rejects malformed cached family metadata', () => {
	const id = discoveredModelId('foundry', 'invalid-family-fixture');
	const entry: DiscoveredModel = { id, provider: 'foundry', model: 'invalid-family-fixture', label: 'Fixture', tools: 'unknown', images: 'unknown', chat: 'unknown', fetchedAt: 1 };
	for (const modelFamily of ['', 'bad\nfamily', 'x'.repeat(513), 5, { name: 'foundry-gpt-5' }]) {
		registerDiscoveredModels([{ ...entry, modelFamily: modelFamily as string }]);
		assert.equal(getDiscoveredModel(id), undefined);
	}
});
