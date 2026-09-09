/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderDiscovery, type ProviderDiscoverySnapshot } from './ProviderDiscovery';
import { discoveredModelId, getDiscoveredModel, markDiscoveredToolsVerified, registerDiscoveredModels, replaceDiscoveredModels, type DiscoveredModel } from './DiscoveredModels';
import { providerForModel } from './LlmClient';
import type { MementoStore } from '../host';

const settings = { foundry: 'foundryDeployments', bedrock: 'bedrockModelMap', zai: 'zaiModels' } as const;
const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
async function fixture(t: TestContext) {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-configured-inventory-'));
	const values: Record<string, unknown> = {};
	const saved = new Map<string, ProviderDiscoverySnapshot>();
	const state: MementoStore = { get: <T>(key: string, fallback?: T) => (saved.get(key) ?? fallback) as T, update: async (key, value) => { saved.set(key, structuredClone(value) as ProviderDiscoverySnapshot); } };
	const config = { get: <T>(key: string, fallback?: T): T => { const value = values[key]; if (value instanceof Error) { throw value; } return (Object.hasOwn(values, key) ? value : fallback) as T; } };
	const instances: ProviderDiscovery[] = []; let requests = 0;
	const create = () => { const finder = new ProviderDiscovery({ home, env: { PATH: '' }, secrets, state, config, request: async () => { requests++; throw new Error('Configured inventories must not make management/inference requests'); } }); instances.push(finder); return finder; };
	t.after(() => { for (const finder of instances) { finder.dispose(); } return rm(home, { recursive: true, force: true }); });
	return { values, saved, create, requests: () => requests };
}

test('Z.AI credential removal and credential read failures do not change configured inventory authority', async t => {
	const f = await fixture(t); f.values.zaiModels = ['configured-model']; f.values.zaiApiKey = 'fixture-key';
	const finder = f.create();
	const initial = (await finder.refresh()).providers.find(provider => provider.id === 'zai')!;
	assert.deepEqual({ credential: initial.credentialSource, status: initial.catalogStatus, complete: initial.configurationComplete, route: providerForModel(discoveredModelId('zai', 'configured-model')) }, { credential: 'setting', status: 'catalog-unavailable', complete: true, route: 'zai' });
	delete f.values.zaiApiKey;
	const withoutCredential = (await finder.refresh({ force: true })).providers.find(provider => provider.id === 'zai')!;
	assert.deepEqual({ credential: withoutCredential.credentialSource, models: withoutCredential.models.map(model => model.model), complete: withoutCredential.configurationComplete }, { credential: 'none', models: ['configured-model'], complete: true });
	f.values.zaiApiKey = new Error('private-keyring-secret'); f.values.zaiModels = [];
	const cleared = (await finder.refresh({ force: true })).providers.find(provider => provider.id === 'zai')!;
	assert.deepEqual({ credential: cleared.credentialSource, status: cleared.catalogStatus, complete: cleared.configurationComplete, removed: getDiscoveredModel(discoveredModelId('zai', 'configured-model')), models: cleared.models, leaked: JSON.stringify(cleared).includes('private-'), requests: f.requests() }, { credential: 'none', status: 'catalog-unavailable', complete: true, removed: undefined, models: [], leaked: false, requests: 0 });
});

test('Z.AI accepts the complete bounded list without truncation and restores verified capabilities only for retained IDs', async t => {
	const f = await fixture(t); const boundary = 'g'.repeat(512);
	f.values.zaiModels = [boundary, ...Array.from({ length: 999 }, (_, index) => `glm-configured-${index}`)];
	const finder = f.create();
	const initial = (await finder.refresh()).providers.find(provider => provider.id === 'zai')!;
	assert.deepEqual({ count: initial.models.length, complete: initial.configurationComplete, tools: initial.models[0].tools, route: providerForModel(discoveredModelId('zai', boundary)), requests: f.requests() }, { count: 1000, complete: true, tools: 'unknown', route: 'zai', requests: 0 });
	markDiscoveredToolsVerified(discoveredModelId('zai', boundary)); await finder.captureAdvertisedModels();
	f.values.zaiModels = [boundary]; const reopened = f.create();
	assert.deepEqual({ retained: reopened.snapshot().providers.find(provider => provider.id === 'zai')?.models.map(model => model.model), tools: getDiscoveredModel(discoveredModelId('zai', boundary))?.tools, removed: getDiscoveredModel(discoveredModelId('zai', 'glm-configured-998')) }, { retained: [boundary], tools: true, removed: undefined });
});

for (const provider of ['foundry', 'bedrock', 'zai'] as const) {
	const other = provider === 'foundry' ? 'bedrock' : 'foundry'; const setting = settings[provider];
	const configured = (map: Record<string, string>): string | string[] => provider === 'zai' ? Object.values(map) : JSON.stringify(map);
	const nonemptyStatus = provider === 'zai' ? 'catalog-unavailable' : 'configuration-only';
	const emptyStatus = provider === 'zai' ? 'catalog-unavailable' : 'not-configured';
	test(`${provider} valid configured inventories replace only their provider scope, including empty`, async t => {
		const f = await fixture(t);
		f.values[setting] = configured({ old: 'removed-route', kept: 'retained-route' });
		f.values[settings[other]] = JSON.stringify({ independent: 'removed-route' });
		const finder = f.create(); await finder.refresh();
		f.values[setting] = configured({ renamed: 'retained-route', added: 'new-route' });
		const changed = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
		assert.deepEqual({ removed: getDiscoveredModel(discoveredModelId(provider, 'removed-route')), retained: getDiscoveredModel(discoveredModelId(provider, 'retained-route'))?.label, added: providerForModel(discoveredModelId(provider, 'new-route')), other: providerForModel(discoveredModelId(other, 'removed-route')), status: changed.catalogStatus, complete: changed.configurationComplete, inference: changed.inferenceStatus, tools: changed.models.map(model => model.tools), requests: f.requests() }, { removed: undefined, retained: provider === 'zai' ? 'retained-route' : 'renamed · retained-route', added: provider, other, status: nonemptyStatus, complete: true, inference: 'not-tested', tools: ['unknown', 'unknown'], requests: 0 });
		assert.throws(() => providerForModel(discoveredModelId(provider, 'removed-route')), /Refresh/);
		f.values[setting] = configured({}); const empty = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
		assert.deepEqual({ status: empty.catalogStatus, complete: empty.configurationComplete, models: empty.models, retired: getDiscoveredModel(discoveredModelId(provider, 'retained-route')), other: providerForModel(discoveredModelId(other, 'removed-route')) }, { status: emptyStatus, complete: true, models: [], retired: undefined, other });
	});

	test(`${provider} invalid JSON, map entries, bounds and config reads preserve the last usable inventory`, async t => {
		const f = await fixture(t); f.values[setting] = configured({ original: 'last-good-route' });
		const finder = f.create(); await finder.refresh();
		const malformed: unknown[] = provider === 'zai' ? ['{"private-secret":', '[]', null, true, ['never-installed', 3], ['   '], ['\u0000'], ['a'.repeat(513)], Array.from({ length: 1001 }, (_, index) => `route-${index}`), new Array(1), { model: 'not-an-array' }, new Error('private-config-read-secret')] : ['{"private-secret":', '[]', 'null', 'true', '{"new":"never-installed","bad":3}', '{"bad":"   "}', JSON.stringify({ bad: '\u0000' }), JSON.stringify({ bad: 'a'.repeat(513) }), JSON.stringify(Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`label-${index}`, `route-${index}`]))), ' '.repeat(1024 * 1024 + 1), 5, new Error('private-config-read-secret')];
		for (const value of malformed) {
			f.values[setting] = value;
			const row = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
			assert.deepEqual({ status: row.catalogStatus, complete: row.configurationComplete, models: row.models.map(model => model.model), route: providerForModel(discoveredModelId(provider, 'last-good-route')), partial: getDiscoveredModel(discoveredModelId(provider, 'never-installed')), leaked: JSON.stringify(row).includes('private-') }, { status: 'error', complete: false, models: ['last-good-route'], route: provider, partial: undefined, leaked: false });
		}
		f.values[setting] = configured({ recovered: 'valid-again' }); await finder.refresh({ force: true });
		assert.deepEqual({ old: getDiscoveredModel(discoveredModelId(provider, 'last-good-route')), recovered: providerForModel(discoveredModelId(provider, 'valid-again')) }, { old: undefined, recovered: provider });
	});

	test(`${provider} cleared settings are explicit complete empty inventories`, async t => {
		const f = await fixture(t); const finder = f.create();
		for (const empty of provider === 'zai' ? [undefined, []] : [undefined, '', ' \n ', '{}']) {
			f.values[setting] = configured({ original: 'remove-me' }); await finder.refresh({ force: true });
			f.values[setting] = empty; const row = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
			assert.deepEqual({ complete: row.configurationComplete, status: row.catalogStatus, models: row.models, old: getDiscoveredModel(discoveredModelId(provider, 'remove-me')) }, { complete: true, status: emptyStatus, models: [], old: undefined });
		}
	});

	test(`${provider} constructor reconciles current settings before a fresh cache can resurrect a removed route`, async t => {
		const f = await fixture(t); f.values[setting] = configured({ stale: 'stale-cached-route' });
		const initial = f.create(); await initial.refresh(); initial.dispose();
		const cached = f.saved.get('sota.providerDiscovery.v1')!;
		assert.ok(cached.providers.find(row => row.id === provider)?.models.length);
		f.values[setting] = configured({}); const reopened = f.create();
		assert.deepEqual({ currentModels: reopened.snapshot().providers.find(row => row.id === provider)?.models, route: getDiscoveredModel(discoveredModelId(provider, 'stale-cached-route')), complete: reopened.snapshot().providers.find(row => row.id === provider)?.configurationComplete }, { currentModels: [], route: undefined, complete: true });
		assert.throws(() => providerForModel(discoveredModelId(provider, 'stale-cached-route')), /Refresh/);
		await reopened.refresh(); assert.equal(getDiscoveredModel(discoveredModelId(provider, 'stale-cached-route')), undefined);
	});

	test(`${provider} restart with invalid configuration preserves cached verified routes without trusting foreign entries`, async t => {
		const f = await fixture(t); f.values[setting] = configured({ retained: 'verified-cached-route' });
		const initial = f.create(); await initial.refresh();
		const id = discoveredModelId(provider, 'verified-cached-route'); markDiscoveredToolsVerified(id); await initial.captureAdvertisedModels(); initial.dispose();
		const foreign: DiscoveredModel = { id: discoveredModelId('openai', 'independent-route'), provider: 'openai', model: 'independent-route', label: 'Do not replace', chat: true, tools: false, images: false, fetchedAt: 1 };
		registerDiscoveredModels([foreign]);
		f.saved.get('sota.providerDiscovery.v1')!.providers.find(row => row.id === provider)!.models.push({ ...foreign, label: 'Poisoned cached owner' });
		replaceDiscoveredModels({ provider }, []); f.values[setting] = '{broken';
		const reopened = f.create(); const row = reopened.snapshot().providers.find(row => row.id === provider)!;
		assert.deepEqual({ status: row.catalogStatus, complete: row.configurationComplete, retained: row.models.map(model => model.model), tools: getDiscoveredModel(id)?.tools, routed: providerForModel(id), foreign: getDiscoveredModel(foreign.id)?.label }, { status: 'error', complete: false, retained: ['verified-cached-route'], tools: true, routed: provider, foreign: 'Do not replace' });
	});
}
