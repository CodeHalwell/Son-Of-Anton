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

const settings = { foundry: 'foundryDeployments', bedrock: 'bedrockModelMap' } as const;
const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
async function fixture(t: TestContext) {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-configured-inventory-'));
	const values: Record<string, unknown> = {};
	const saved = new Map<string, ProviderDiscoverySnapshot>();
	const state: MementoStore = { get: <T>(key: string, fallback?: T) => (saved.get(key) ?? fallback) as T, update: async (key, value) => { saved.set(key, structuredClone(value) as ProviderDiscoverySnapshot); } };
	const config = { get: <T>(key: string, fallback?: T): T => { const value = values[key]; if (value instanceof Error) { throw value; } return (value ?? fallback) as T; } };
	const instances: ProviderDiscovery[] = []; let requests = 0;
	const create = () => { const finder = new ProviderDiscovery({ home, env: { PATH: '' }, secrets, state, config, request: async () => { requests++; throw new Error('Configured inventories must not make management/inference requests'); } }); instances.push(finder); return finder; };
	t.after(() => { for (const finder of instances) { finder.dispose(); } return rm(home, { recursive: true, force: true }); });
	return { values, saved, create, requests: () => requests };
}

for (const provider of ['foundry', 'bedrock'] as const) {
	const other = provider === 'foundry' ? 'bedrock' : 'foundry'; const setting = settings[provider];
	test(`${provider} valid configured inventories replace only their provider scope, including empty`, async t => {
		const f = await fixture(t);
		f.values[setting] = JSON.stringify({ old: 'removed-route', kept: 'retained-route' });
		f.values[settings[other]] = JSON.stringify({ independent: 'removed-route' });
		const finder = f.create(); await finder.refresh();
		f.values[setting] = JSON.stringify({ renamed: 'retained-route', added: 'new-route' });
		const changed = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
		assert.deepEqual({ removed: getDiscoveredModel(discoveredModelId(provider, 'removed-route')), retained: getDiscoveredModel(discoveredModelId(provider, 'retained-route'))?.label, added: providerForModel(discoveredModelId(provider, 'new-route')), other: providerForModel(discoveredModelId(other, 'removed-route')), status: changed.catalogStatus, complete: changed.configurationComplete, inference: changed.inferenceStatus, tools: changed.models.map(model => model.tools), requests: f.requests() }, { removed: undefined, retained: 'renamed · retained-route', added: provider, other, status: 'configuration-only', complete: true, inference: 'not-tested', tools: ['unknown', 'unknown'], requests: 0 });
		assert.throws(() => providerForModel(discoveredModelId(provider, 'removed-route')), /Refresh/);
		f.values[setting] = '{}'; const empty = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
		assert.deepEqual({ status: empty.catalogStatus, complete: empty.configurationComplete, models: empty.models, retired: getDiscoveredModel(discoveredModelId(provider, 'retained-route')), other: providerForModel(discoveredModelId(other, 'removed-route')) }, { status: 'not-configured', complete: true, models: [], retired: undefined, other });
	});

	test(`${provider} invalid JSON, map entries, bounds and config reads preserve the last usable inventory`, async t => {
		const f = await fixture(t); f.values[setting] = JSON.stringify({ original: 'last-good-route' });
		const finder = f.create(); await finder.refresh();
		const malformed: unknown[] = ['{"private-secret":', '[]', 'null', 'true', '{"new":"never-installed","bad":3}', '{"bad":"   "}', JSON.stringify({ bad: '\u0000' }), JSON.stringify({ bad: 'a'.repeat(513) }), JSON.stringify(Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`label-${index}`, `route-${index}`]))), ' '.repeat(1024 * 1024 + 1), 5, new Error('private-config-read-secret')];
		for (const value of malformed) {
			f.values[setting] = value;
			const row = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
			assert.deepEqual({ status: row.catalogStatus, complete: row.configurationComplete, models: row.models.map(model => model.model), route: providerForModel(discoveredModelId(provider, 'last-good-route')), partial: getDiscoveredModel(discoveredModelId(provider, 'never-installed')), leaked: JSON.stringify(row).includes('private-') }, { status: 'error', complete: false, models: ['last-good-route'], route: provider, partial: undefined, leaked: false });
		}
		f.values[setting] = JSON.stringify({ recovered: 'valid-again' }); await finder.refresh({ force: true });
		assert.deepEqual({ old: getDiscoveredModel(discoveredModelId(provider, 'last-good-route')), recovered: providerForModel(discoveredModelId(provider, 'valid-again')) }, { old: undefined, recovered: provider });
	});

	test(`${provider} absent and blank settings are explicit complete empty inventories`, async t => {
		const f = await fixture(t); const finder = f.create();
		for (const empty of [undefined, '', ' \n ', '{}']) {
			f.values[setting] = JSON.stringify({ original: 'remove-me' }); await finder.refresh({ force: true });
			f.values[setting] = empty; const row = (await finder.refresh({ force: true })).providers.find(row => row.id === provider)!;
			assert.deepEqual({ complete: row.configurationComplete, status: row.catalogStatus, models: row.models, old: getDiscoveredModel(discoveredModelId(provider, 'remove-me')) }, { complete: true, status: 'not-configured', models: [], old: undefined });
		}
	});

	test(`${provider} constructor reconciles current settings before a fresh cache can resurrect a removed route`, async t => {
		const f = await fixture(t); f.values[setting] = JSON.stringify({ stale: 'stale-cached-route' });
		const initial = f.create(); await initial.refresh(); initial.dispose();
		const cached = f.saved.get('sota.providerDiscovery.v1')!;
		assert.ok(cached.providers.find(row => row.id === provider)?.models.length);
		f.values[setting] = '{}'; const reopened = f.create();
		assert.deepEqual({ currentModels: reopened.snapshot().providers.find(row => row.id === provider)?.models, route: getDiscoveredModel(discoveredModelId(provider, 'stale-cached-route')), complete: reopened.snapshot().providers.find(row => row.id === provider)?.configurationComplete }, { currentModels: [], route: undefined, complete: true });
		assert.throws(() => providerForModel(discoveredModelId(provider, 'stale-cached-route')), /Refresh/);
		await reopened.refresh(); assert.equal(getDiscoveredModel(discoveredModelId(provider, 'stale-cached-route')), undefined);
	});

	test(`${provider} restart with invalid configuration preserves cached verified routes without trusting foreign entries`, async t => {
		const f = await fixture(t); f.values[setting] = JSON.stringify({ retained: 'verified-cached-route' });
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
