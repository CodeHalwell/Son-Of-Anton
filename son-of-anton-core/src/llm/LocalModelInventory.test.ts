/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readLocalModelInventory } from './LocalModelInventory';
import { ProviderDiscovery } from './ProviderDiscovery';
import { getDiscoveredModel, discoveredModelId } from './DiscoveredModels';

async function fixture(t: TestContext) {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-local-models-'));
	t.after(() => rm(home, { recursive: true, force: true }));
	const write = async (file: string, value: object | string) => { const target = path.join(home, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value)); return target; };
	return { home, write };
}

test('Codex inventory reads current visible models from CODEX_HOME without importing auth or API entitlements', async t => {
	const f = await fixture(t); const timestamp = new Date(Date.now() - 1000).toISOString();
	await f.write('custom/auth.json', { access_token: 'PRIVATE_AUTH' });
	await f.write('custom/models_cache.json', { fetched_at: timestamp, private: 'PRIVATE_CACHE_FIELD', models: [
		{ slug: 'future-code-model', display_name: 'Future Code', visibility: 'list', supported_in_api: false, internal: 'PRIVATE_MODEL_FIELD' },
		{ slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
		{ slug: 'sk-do-not-export', display_name: 'Secret', visibility: 'list' },
	] });
	const catalog = await readLocalModelInventory('codex', f.home, { CODEX_HOME: path.join(f.home, 'custom') });
	assert.deepEqual(catalog?.models, [{ id: 'future-code-model', label: 'Future Code' }]);
	assert.equal(catalog?.updatedAt, Date.parse(timestamp)); assert.doesNotMatch(JSON.stringify(catalog), /PRIVATE|hidden-model|sk-do-not/);
	assert.equal(getDiscoveredModel(discoveredModelId('openai', 'future-code-model')), undefined);
});

test('local catalog refresh observes additions and removals without hardcoded model names', async t => {
	const f = await fixture(t); const file = '.codex/models_cache.json';
	await f.write(file, { models: [{ slug: 'old-code', visibility: 'list' }] });
	assert.equal((await readLocalModelInventory('codex', f.home, {}))?.models[0].id, 'old-code');
	await f.write(file, { models: [{ slug: 'brand-new-code', visibility: 'list' }] });
	assert.deepEqual((await readLocalModelInventory('codex', f.home, {}))?.models, [{ id: 'brand-new-code', label: 'brand-new-code' }]);
	await f.write(file, { models: [] });
	assert.deepEqual((await readLocalModelInventory('codex', f.home, {}))?.models, []);
	await rm(path.join(f.home, file)); assert.equal(await readLocalModelInventory('codex', f.home, {}), undefined);
});

test('Claude additional model variants and Cursor selected model IDs are preserved exactly', async t => {
	const f = await fixture(t);
	await f.write('.claude.json', { oauthAccount: { private: 'PRIVATE_ACCOUNT' }, additionalModelOptionsCache: [{ value: 'future-claude[1m]', label: 'Future Claude' }] });
	await f.write('.cursor/cli-config.json', { model: { modelId: 'cursor-future', displayName: 'Cursor Future' }, selectedModel: { modelId: 'cursor-future', parameters: [{ token: 'PRIVATE_PARAMETER' }] } });
	const claude = await readLocalModelInventory('claude', f.home, {}); const cursor = await readLocalModelInventory('cursor', f.home, {});
	assert.deepEqual([claude?.models, cursor?.models], [[{ id: 'future-claude[1m]', label: 'Future Claude' }], [{ id: 'cursor-future', label: 'Cursor Future' }]]);
	assert.doesNotMatch(JSON.stringify([claude, cursor]), /PRIVATE/);
});

test('malformed, oversized and unsupported local cache formats do not become catalogs', async t => {
	const f = await fixture(t);
	for (const value of ['{broken', { models: {} }, ' '.repeat(8 * 1024 * 1024 + 1)]) {
		await f.write('.codex/models_cache.json', value); assert.equal(await readLocalModelInventory('codex', f.home, {}), undefined);
	}
	assert.equal(await readLocalModelInventory('unrecognized', f.home, {}), undefined);
});

test('provider discovery finds native user installs with an empty GUI PATH and reports local catalogs separately', async t => {
	const f = await fixture(t); const executable = await f.write('.local/bin/claude', '#!/bin/sh\necho MUST_NOT_RUN'); await chmod(executable, 0o700);
	await f.write('.claude/settings.json', { model: 'future-claude[1m]' });
	await f.write('.claude.json', { additionalModelOptionsCache: [{ value: 'future-claude[1m]', label: 'Future Claude' }] });
	await f.write('.codex/models_cache.json', { models: [{ slug: 'future-code-model', visibility: 'list' }] });
	const finder = new ProviderDiscovery({ home: f.home, env: { PATH: '' }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }, config: { get: <T>(_key: string, fallback?: T) => fallback as T }, request: async () => { throw new Error('Unexpected network request'); } });
	t.after(() => finder.dispose()); const snapshot = await finder.refresh(); const claude = snapshot.software.find(item => item.id === 'claude')!;
	assert.deepEqual([claude.executable, claude.configuredModels], [executable, ['future-claude[1m]']]);
	const provider = snapshot.providers.find(item => item.id === 'codex')!;
	assert.deepEqual([provider.catalogStatus, provider.models, provider.localModelCatalog?.models], ['adapter-required', [], [{ id: 'future-code-model', label: 'future-code-model' }]]);
	assert.equal(getDiscoveredModel(discoveredModelId('codex', 'future-code-model')), undefined);
});
