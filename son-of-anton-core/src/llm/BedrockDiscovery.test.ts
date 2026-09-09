/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BedrockRuntimeClient, type InvokeModelWithResponseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import type { MementoStore } from '../host';
import { ProviderDiscovery, type ProviderDiscoverySnapshot } from './ProviderDiscovery';
import { discoveredModelId, getDiscoveredModel, markDiscoveredToolsVerified, replaceDiscoveredModels } from './DiscoveredModels';
import { LlmClient, modelSupportsImages, supportsAgenticToolLoop, type ModelId } from './LlmClient';

const profileArn = 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a1b2c3d4e5f6';

async function fixture(t: TestContext, family: string, invocationId = profileArn) {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-bedrock-family-'));
	const values: Record<string, string | number> = { bedrockModelMap: JSON.stringify({ [family]: invocationId }), bedrockRegion: 'us-east-1', thinkingBudgetTokens: 1024 };
	const config = { get: <T>(key: string, fallback?: T): T => (values[key] ?? fallback) as T };
	const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
	const saved = new Map<string, ProviderDiscoverySnapshot>();
	const state: MementoStore = { get: <T>(key: string, fallback?: T) => (saved.get(key) ?? fallback) as T, update: async (key, value) => { saved.set(key, JSON.parse(JSON.stringify(value)) as ProviderDiscoverySnapshot); } };
	const instances: ProviderDiscovery[] = [];
	const create = () => {
		const finder = new ProviderDiscovery({ config, secrets, state, home, env: { PATH: '' }, request: async () => { throw new Error('Configured Bedrock discovery must not call provider APIs'); } });
		instances.push(finder); return finder;
	};
	const requests: Array<{ modelId: string | undefined; body: Record<string, unknown> }> = [];
	t.mock.method(BedrockRuntimeClient.prototype, 'send', async (command: InvokeModelWithResponseStreamCommand) => {
		requests.push({ modelId: command.input.modelId, body: JSON.parse(new TextDecoder().decode(command.input.body as Uint8Array)) });
		return { body: (async function* () {
			for (const frame of [
				{ type: 'message_start', message: { usage: { input_tokens: 10 } } },
				{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working' } },
				{ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
			]) { yield { chunk: { bytes: new TextEncoder().encode(JSON.stringify(frame)) } }; }
		})() };
	});
	const infer = async (model: ModelId, tools = true) => {
		const llm = new LlmClient(secrets, config);
		let text = '';
		for await (const event of llm.streamRequest({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Explain this fixture' }, { type: 'image', mimeType: 'image/png', base64Data: 'aGVsbG8=' }] }], maxTokens: 2048,
			...(tools ? { tools: [{ name: 'read_fixture', description: 'Read a test fixture', inputSchema: { type: 'object' as const, properties: {} } }] } : {}),
		})) {
			assert.notEqual(event.type, 'error', JSON.stringify(event));
			if (event.type === 'token') { text += event.token; }
		}
		assert.equal(text, 'working');
		return requests.at(-1)!;
	};
	t.after(async () => { for (const finder of instances) { finder.dispose(); } replaceDiscoveredModels({ provider: 'bedrock' }, []); await rm(home, { recursive: true, force: true }); });
	return { values, saved, create, infer, requests };
}

for (const family of ['bedrock-claude-opus-4', 'bedrock-claude-sonnet-4', 'bedrock-claude-haiku-4', 'bedrock-claude-3-7-sonnet', 'bedrock-claude-sonnet', 'bedrock-claude-haiku'] as const) {
	test(`${family}: opaque profile preserves alias capabilities and SDK request semantics after catalog restart`, async t => {
		const f = await fixture(t, family);
		const original = await f.infer(family);
		const finder = f.create(); await finder.refresh(); finder.dispose();
		const id = discoveredModelId('bedrock', profileArn);
		const cached = f.saved.get('sota.providerDiscovery.v1')!.providers.find(provider => provider.id === 'bedrock')!.models[0];
		assert.equal(cached.modelFamily, family);
		cached.label = 'Misleading display name';
		replaceDiscoveredModels({ provider: 'bedrock' }, []);
		f.create();
		const metadata = getDiscoveredModel(id)!;
		const images = family !== 'bedrock-claude-haiku';
		assert.deepEqual({ family: metadata.modelFamily, model: metadata.model, chat: metadata.chat, tools: metadata.tools, images: metadata.images, tested: metadata.verifiedAt }, { family, model: profileArn, chat: true, tools: true, images, tested: undefined });
		assert.deepEqual([supportsAgenticToolLoop(id), modelSupportsImages(id)], [supportsAgenticToolLoop(family), modelSupportsImages(family)]);
		const discovered = await f.infer(id);
		assert.deepEqual(discovered, original);
		assert.equal(discovered.modelId, profileArn);
		assert.deepEqual(discovered.body.tools, [{ name: 'read_fixture', description: 'Read a test fixture', input_schema: { type: 'object', properties: {} } }]);
		assert.equal(JSON.stringify(discovered.body.messages).includes('aGVsbG8='), images);
		assert.deepEqual(discovered.body.thinking, family.endsWith('-4') ? { type: 'enabled', budget_tokens: 1024 } : undefined);
	});
}

test('Bedrock cached family survives unreadable configuration and changes invalidate old capabilities', async t => {
	const f = await fixture(t, 'bedrock-claude-sonnet-4');
	const finder = f.create(); await finder.refresh();
	const id = discoveredModelId('bedrock', profileArn);
	markDiscoveredToolsVerified(id); await finder.captureAdvertisedModels(); finder.dispose();
	const cached = f.saved.get('sota.providerDiscovery.v1')!.providers.find(provider => provider.id === 'bedrock')!.models[0];
	cached.label = 'bedrock-nova-pro';
	replaceDiscoveredModels({ provider: 'bedrock' }, []);
	f.values.bedrockModelMap = '{broken'; t.mock.method(console, 'warn', () => {});
	const reopened = f.create();
	assert.deepEqual([getDiscoveredModel(id)?.modelFamily, getDiscoveredModel(id)?.tools], ['bedrock-claude-sonnet-4', true]);
	assert.deepEqual((await f.infer(id)).body.thinking, { type: 'enabled', budget_tokens: 1024 });
	f.values.bedrockModelMap = JSON.stringify({ 'bedrock-claude-haiku': profileArn }); await reopened.refresh({ force: true });
	assert.deepEqual({ family: getDiscoveredModel(id)?.modelFamily, images: modelSupportsImages(id), tested: getDiscoveredModel(id)?.verifiedAt, thinking: (await f.infer(id)).body.thinking }, { family: 'bedrock-claude-haiku', images: false, tested: undefined, thinking: undefined });
	markDiscoveredToolsVerified(id);
	f.values.bedrockModelMap = JSON.stringify({ 'bedrock-nova-pro': profileArn }); await reopened.refresh({ force: true });
	assert.deepEqual({ family: getDiscoveredModel(id)?.modelFamily, chat: getDiscoveredModel(id)?.chat, tools: getDiscoveredModel(id)?.tools, images: getDiscoveredModel(id)?.images, tested: getDiscoveredModel(id)?.verifiedAt }, { family: 'bedrock-nova-pro', chat: false, tools: 'unknown', images: 'unknown', tested: undefined });
	const previousCalls = f.requests.length;
	await assert.rejects(f.infer(id), /not available for chat/);
	assert.equal(f.requests.length, previousCalls);
});

test('legacy Bedrock catalog is upgraded from configuration, never from an opaque profile or its label', async t => {
	const f = await fixture(t, 'bedrock-claude-sonnet-4');
	const finder = f.create(); await finder.refresh(); finder.dispose();
	const cached = f.saved.get('sota.providerDiscovery.v1')!.providers.find(provider => provider.id === 'bedrock')!.models[0];
	delete cached.modelFamily; cached.chat = false; cached.tools = 'unknown'; cached.images = 'unknown'; cached.label = 'bedrock-nova-pro';
	replaceDiscoveredModels({ provider: 'bedrock' }, []);
	const reopened = f.create(); const id = discoveredModelId('bedrock', profileArn);
	assert.deepEqual(reopened.snapshot().providers.find(provider => provider.id === 'bedrock')!.models.map(model => [model.modelFamily, model.chat, model.tools, model.images]), [['bedrock-claude-sonnet-4', true, true, true]]);
	assert.equal((await f.infer(id)).modelId, profileArn);
	f.values.bedrockModelMap = JSON.stringify({ 'unrecognized-family': profileArn }); await reopened.refresh({ force: true });
	assert.deepEqual([getDiscoveredModel(id)?.chat, getDiscoveredModel(id)?.tools, getDiscoveredModel(id)?.images], [false, 'unknown', 'unknown']);
});

test('raw Claude invocation IDs and unknown declared Claude families retain unknown tool and image capability', async t => {
	const wire = 'us.anthropic.claude-3-5-sonnet-20241022-v2:0';
	const f = await fixture(t, 'my-custom-name', wire);
	const finder = f.create(); await finder.refresh();
	for (const [family, invocationId] of [['my-custom-name', wire], ['bedrock-claude-custom', profileArn]]) {
		f.values.bedrockModelMap = JSON.stringify({ [family]: invocationId }); await finder.refresh({ force: true });
		const id = discoveredModelId('bedrock', invocationId);
		assert.deepEqual([getDiscoveredModel(id)?.chat, getDiscoveredModel(id)?.tools, getDiscoveredModel(id)?.images, supportsAgenticToolLoop(id), modelSupportsImages(id)], [true, 'unknown', 'unknown', false, false]);
		await assert.rejects(f.infer(id), /has not advertised tool support/);
		const request = await f.infer(id, false);
		assert.equal(request.modelId, invocationId);
		assert.deepEqual([request.body.thinking, request.body.tools, JSON.stringify(request.body.messages).includes('aGVsbG8=')], [undefined, undefined, false]);
	}
});

test('invalid Bedrock family metadata retains the last known configured inventory', async t => {
	const f = await fixture(t, 'bedrock-claude-sonnet-4');
	const finder = f.create(); await finder.refresh();
	for (const family of ['', 'x'.repeat(513), 'invalid\nfamily']) {
		f.values.bedrockModelMap = JSON.stringify({ [family]: profileArn });
		const snapshot = await finder.refresh({ force: true });
		const row = snapshot.providers.find(provider => provider.id === 'bedrock')!;
		assert.deepEqual([row.catalogStatus, row.models[0].modelFamily, row.models[0].tools], ['error', 'bedrock-claude-sonnet-4', true]);
	}
});

test('duplicate friendly aliases cannot erase the semantic Bedrock family in either map order or after restart', async t => {
	const f = await fixture(t, 'bedrock-claude-sonnet-4');
	for (const aliases of [
		['bedrock-claude-sonnet-4', 'my-profile', 'bedrock-production', 'bedrock-custom'],
		['bedrock-custom', 'bedrock-production', 'my-profile', 'bedrock-claude-sonnet-4'],
	]) {
		f.values.bedrockModelMap = JSON.stringify(Object.fromEntries(aliases.map(alias => [alias, profileArn])));
		const finder = f.create(); await finder.refresh(); finder.dispose();
		replaceDiscoveredModels({ provider: 'bedrock' }, []);
		const reopened = f.create();
		const row = reopened.snapshot().providers.find(provider => provider.id === 'bedrock')!;
		assert.deepEqual(row.models.map(model => [model.modelFamily, model.chat, model.tools, model.images]), [['bedrock-claude-sonnet-4', true, true, true]]);
		assert.equal((await f.infer(discoveredModelId('bedrock', profileArn))).modelId, profileArn);
		reopened.dispose();
	}
});

test('conflicting declared Bedrock families report ambiguity and preserve the previous valid route', async t => {
	const f = await fixture(t, 'bedrock-claude-sonnet-4');
	const finder = f.create(); await finder.refresh();
	for (const other of ['bedrock-claude-haiku', 'bedrock-nova-pro']) {
		for (const aliases of [['bedrock-claude-sonnet-4', other], [other, 'bedrock-claude-sonnet-4']]) {
			f.values.bedrockModelMap = JSON.stringify(Object.fromEntries(aliases.map(alias => [alias, profileArn])));
			const row = (await finder.refresh({ force: true })).providers.find(provider => provider.id === 'bedrock')!;
			assert.equal(row.catalogStatus, 'error');
			assert.match(row.error ?? '', /Multiple Bedrock model families/);
			assert.deepEqual(row.models.map(model => [model.modelFamily, model.chat, model.tools]), [['bedrock-claude-sonnet-4', true, true]]);
		}
	}
	finder.dispose(); replaceDiscoveredModels({ provider: 'bedrock' }, []);
	const reopened = f.create();
	assert.match(reopened.snapshot().providers.find(provider => provider.id === 'bedrock')!.error ?? '', /Multiple Bedrock model families/);
	assert.equal((await f.infer(discoveredModelId('bedrock', profileArn))).modelId, profileArn);
});
