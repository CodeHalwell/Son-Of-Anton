/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MementoStore } from '../host';
import { AcpConnection } from '../acp/AcpConnection';
import { AcpRuntime } from '../acp/AcpRuntime';
import type { AcpAgentDefinition } from '../acp/protocol';
import { ProviderDiscovery, type ProviderDiscoverySnapshot } from './ProviderDiscovery';
import { beginAcpModelCatalog, discoveredAcpModelId, discoveredAcpModels, discoveredModelId, getDiscoveredModel, registerDiscoveredModels, replaceDiscoveredModels, type DiscoveredModel } from './DiscoveredModels';

const first: AcpAgentDefinition = { id: 'first', command: 'first-adapter', env: { ACCESS_TOKEN: 'PRIVATE_FIXTURE_TOKEN' } };
const second: AcpAgentDefinition = { id: 'second', command: 'second-adapter' };
function model(agent: AcpAgentDefinition, name = 'model'): DiscoveredModel { return { id: discoveredAcpModelId(agent.id, name), provider: 'acp', acpAdapterId: agent.id, model: name, label: name, chat: true, tools: true, images: false, fetchedAt: 1 }; }
function publish(agent: AcpAgentDefinition, name = 'model'): void { beginAcpModelCatalog(agent)([model(agent, name)], false); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext, agents: AcpAgentDefinition[] = [first, second]) {
	const home = await mkdtemp(path.join(os.tmpdir(), 'sota-acp-catalog-'));
	const settings: { agents: unknown; fail?: boolean } = { agents };
	const saved = new Map<string, ProviderDiscoverySnapshot>();
	const state: MementoStore = { get: <T>(key: string, fallback?: T) => (saved.get(key) ?? fallback) as T, update: async (key, value) => { saved.set(key, structuredClone(value) as ProviderDiscoverySnapshot); } };
	const instances: ProviderDiscovery[] = [];
	const create = () => {
		const finder = new ProviderDiscovery({ home, env: { PATH: '' }, state, config: { get: <T>(key: string, fallback?: T) => { if (key === 'acp.agents') { if (settings.fail) { throw new Error('PRIVATE_CONFIG_ERROR'); } return settings.agents as T; } return fallback as T; } }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }, request: async () => { throw new Error('No provider calls expected'); } });
		instances.push(finder); return finder;
	};
	const finder = create();
	t.after(async () => { for (const instance of instances) { instance.dispose(); } for (const entry of discoveredAcpModels()) { if (entry.acpAdapterId) { replaceDiscoveredModels({ provider: 'acp', acpAdapterId: entry.acpAdapterId }, []); } } await rm(home, { recursive: true, force: true }); });
	return { finder, create, settings, saved };
}

test('removed adapters retire their models immediately without removing survivors or unrelated providers', async t => {
	const f = await fixture(t); publish(first); publish(second);
	const late = beginAcpModelCatalog(first); const cached = { ...getDiscoveredModel(model(first).id)! };
	const remote: DiscoveredModel = { id: discoveredModelId('openai', 'unrelated'), provider: 'openai', model: 'unrelated', label: 'Unrelated', chat: true, tools: true, images: false, fetchedAt: 1 };
	registerDiscoveredModels([remote]); t.after(() => replaceDiscoveredModels({ provider: 'openai' }, []));
	f.settings.agents = [second]; const row = f.finder.refreshAcpAdapters().providers.find(provider => provider.id === 'acp')!;
	late([model(first, 'late')], false); registerDiscoveredModels([cached]); replaceDiscoveredModels({ provider: 'acp', acpAdapterId: first.id }, [cached]);
	assert.deepEqual([row.configurationComplete, row.models.map(entry => entry.id), getDiscoveredModel(model(first).id), getDiscoveredModel(model(first, 'late').id), getDiscoveredModel(remote.id)?.id], [true, [model(second).id], undefined, undefined, remote.id]);
	f.settings.agents = []; const empty = f.finder.refreshAcpAdapters().providers.find(provider => provider.id === 'acp')!;
	assert.deepEqual([empty.configurationComplete, empty.catalogStatus, empty.models, discoveredAcpModels()], [true, 'adapter-required', [], []]);
});

test('malformed or unreadable adapter configuration preserves the last complete scopes and sanitized diagnostics', async t => {
	const f = await fixture(t); publish(first); publish(second);
	for (const invalid of [null, {}, 'bad', [first, { id: 'second' }], [first, first]]) {
		f.settings.agents = invalid;
		const row = f.finder.refreshAcpAdapters().providers.find(provider => provider.id === 'acp')!;
		assert.deepEqual([row.configurationComplete, row.catalogStatus, row.models.map(entry => entry.id)], [false, 'error', [model(first).id, model(second).id]]);
	}
	f.settings.fail = true;
	await f.finder.captureAdvertisedModels();
	assert.deepEqual(discoveredAcpModels().map(entry => entry.id), [model(first).id, model(second).id]);
	assert.ok(!JSON.stringify(f.finder.snapshot()).includes('PRIVATE_'));
	f.settings.fail = false; f.settings.agents = [second]; f.finder.refreshAcpAdapters();
	assert.equal(getDiscoveredModel(model(first).id), undefined);
});

test('startup rejects removed, changed and unbound cached ACP models while retaining matching definitions', async t => {
	const f = await fixture(t); publish(first); publish(second); await f.finder.captureAdvertisedModels();
	const persisted = f.saved.get('sota.providerDiscovery.v1')!;
	const old = structuredClone(persisted);
	f.finder.dispose();
	f.settings.agents = [second]; const reopened = f.create();
	assert.deepEqual(reopened.snapshot().providers.find(provider => provider.id === 'acp')!.models.map(entry => entry.id), [model(second).id]);
	reopened.dispose(); f.saved.set('sota.providerDiscovery.v1', old);
	f.settings.agents = [{ ...second, command: 'replacement-command' }]; const changed = f.create();
	assert.deepEqual(changed.snapshot().providers.find(provider => provider.id === 'acp')!.models, []);
	changed.dispose();
	for (const entry of old.providers.find(provider => provider.id === 'acp')!.models) { delete entry.acpAdapterFingerprint; }
	f.saved.set('sota.providerDiscovery.v1', old); f.settings.agents = [first, second];
	assert.deepEqual(f.create().snapshot().providers.find(provider => provider.id === 'acp')!.models, [], 'Old caches without a definition binding need fresh session advertisement');
});

test('publication generations reject remove/re-add and changed definitions while accepting model overlays', async t => {
	const f = await fixture(t); const stale = beginAcpModelCatalog(first);
	f.settings.agents = [second]; f.finder.refreshAcpAdapters();
	f.settings.agents = [first, second]; f.finder.refreshAcpAdapters();
	stale([model(first)], false); assert.equal(getDiscoveredModel(model(first).id), undefined);
	const replacement = { ...first, command: 'new-adapter', env: { ...first.env, ANTHROPIC_MODEL: 'sonnet' } };
	f.settings.agents = [replacement, second]; f.finder.refreshAcpAdapters();
	publish(first); assert.equal(getDiscoveredModel(model(first).id), undefined);
	publish({ ...replacement, modelId: 'model', env: { ...replacement.env, ANTHROPIC_MODEL: 'opus' } });
	assert.equal(getDiscoveredModel(model(first).id)?.id, model(first).id);
	assert.ok(!JSON.stringify(f.finder.snapshot()).includes('PRIVATE_FIXTURE_TOKEN'));
});

for (const scenario of ['remove', 'replace', 'readd'] as const) {
	test(`an actual delayed ACP session cannot publish after adapter ${scenario}`, async t => {
		const agent = { id: 'runtime-fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')], env: { FIXTURE_MODELS: '1' } };
		const f = await fixture(t, [agent]); const runtime = new AcpRuntime();
		const entered = deferred(), release = deferred();
		const original = AcpConnection.prototype.newSession;
		t.mock.method(AcpConnection.prototype, 'newSession', async function (this: AcpConnection, ...args: Parameters<typeof original>) { await original.apply(this, args); entered.resolve(); await release.promise; });
		t.after(async () => { release.resolve(); await runtime.shutdown(); });
		const pending = runtime.run({ agent, cwd: process.cwd(), conversationId: scenario, text: 'hello' });
		await entered.promise;
		f.settings.agents = []; f.finder.refreshAcpAdapters();
		if (scenario !== 'remove') { f.settings.agents = [{ ...agent, ...(scenario === 'replace' ? { args: [...agent.args, '--replacement'] } : {}) }]; f.finder.refreshAcpAdapters(); }
		release.resolve(); assert.deepEqual(await pending, { stopReason: 'end_turn' });
		assert.deepEqual(discoveredAcpModels(), []);
	});
}

test('ACP publication generation is captured before a turn waits for a process slot', async t => {
	const agent = { id: 'queued-fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')], env: { FIXTURE_MODELS: '1' } };
	const f = await fixture(t, [agent]); const runtime = new AcpRuntime({ maxProcesses: 1 });
	t.after(() => runtime.shutdown());
	await runtime.run({ agent, cwd: process.cwd(), conversationId: 'busy', text: 'hello' });
	const controller = new AbortController();
	const busy = runtime.run({ agent, cwd: process.cwd(), conversationId: 'busy', text: 'slow', signal: controller.signal });
	const busyCancelled = assert.rejects(busy, /cancelled/);
	const queued = runtime.run({ agent, cwd: process.cwd(), conversationId: 'queued', text: 'hello' });
	assert.equal(runtime.snapshot().queued, 1);
	f.settings.agents = []; f.finder.refreshAcpAdapters();
	f.settings.agents = [agent]; f.finder.refreshAcpAdapters();
	controller.abort(); await busyCancelled; await queued;
	assert.deepEqual(discoveredAcpModels(), []);
});

test('disposing the host catalog policy leaves standalone ACP runtimes able to advertise', async t => {
	const f = await fixture(t, []); f.finder.dispose();
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const agent = { id: 'standalone-fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')], env: { FIXTURE_MODELS: '1' } };
	await runtime.run({ agent, cwd: process.cwd(), conversationId: 'standalone', text: 'hello' });
	assert.equal(getDiscoveredModel(discoveredAcpModelId(agent.id, 'fixture-fast'))?.acpAdapterId, agent.id);
});
