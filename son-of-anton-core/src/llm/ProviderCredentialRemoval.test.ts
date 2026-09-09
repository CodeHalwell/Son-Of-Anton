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
import { discoveredModelId, getDiscoveredModel, type CatalogProvider } from './DiscoveredModels';
import { providerForModel } from './LlmClient';
import type { MementoStore } from '../host';
import { CredentialBroker } from '../auth/CredentialBroker';
import { MissingCredentialError } from '../auth/types';

const settings = { xai: 'xaiApiKey', moonshot: 'moonshotApiKey', minimax: 'minimaxApiKey', anthropic: 'apiKey', openai: 'openaiApiKey', google: 'googleApiKey', openrouter: 'openRouterApiKey', deepseek: 'deepSeekApiKey', mistral: 'mistralApiKey', groq: 'groqApiKey', cerebras: 'cerebrasApiKey', together: 'togetherApiKey', fireworks: 'fireworksApiKey' } as const;
async function fixture(t: TestContext) {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-credential-removal-'));
	const values: Record<string, unknown> = {}; const secretValues = new Map<string, string | Error>(); const brokers = new Map<string, string | Error>();
	const env: NodeJS.ProcessEnv = { PATH: '' }; const saved = new Map<string, ProviderDiscoverySnapshot>();
	const state: MementoStore = { get: <T>(key: string, fallback?: T) => (saved.get(key) ?? fallback) as T, update: async (key, value) => { saved.set(key, structuredClone(value) as ProviderDiscoverySnapshot); } };
	const config = { get: <T>(key: string, fallback?: T): T => { const value = values[key]; if (value instanceof Error) { throw value; } return (Object.hasOwn(values, key) ? value : fallback) as T; } };
	let responseStatus = 200; let requests = 0; let credentialReads = 0;
	const instances: ProviderDiscovery[] = [];
	const create = (credentialResolver?: { getToken(provider: string): Promise<{ token: string } | undefined> }) => {
		const finder = new ProviderDiscovery({ home, env, state, config,
			secrets: { get: async key => { credentialReads++; const value = secretValues.get(key); if (value instanceof Error) { throw value; } return value; }, store: async () => {}, delete: async () => {} },
			credentialResolver: credentialResolver ?? { getToken: async provider => { const value = brokers.get(provider); if (value instanceof Error) { throw value; } return value === undefined ? undefined : { token: value }; } },
			request: async input => {
				requests++; if (responseStatus !== 200) { return new Response('', { status: responseStatus }); }
				return Response.json(String(input).includes('11434') ? { models: [{ name: 'retained-model' }] } : { data: [{ id: 'retained-model', supportedGenerationMethods: ['generateContent'] }] });
			},
		}); instances.push(finder); return finder;
	};
	t.after(() => { for (const finder of instances) { finder.dispose(); } return rm(home, { recursive: true, force: true }); });
	return { values, secretValues, brokers, env, saved, create, requests: () => requests, credentialReads: () => credentialReads, failHttp: (status: number) => { responseStatus = status; } };
}
function row(snapshot: ProviderDiscoverySnapshot, provider: CatalogProvider) { return snapshot.providers.find(value => value.id === provider)!; }

test('the real broker distinguishes absent, unreadable, malformed and unrefreshable stored credentials', async t => {
	const f = await fixture(t); const tokens = new Map<string, string>(); let readFailure = false;
	const secretStore = { get: async (key: string) => { if (readFailure) { throw new Error('private-keyring-error'); } return tokens.get(key); }, store: async (key: string, value: string) => { tokens.set(key, value); }, delete: async (key: string) => { tokens.delete(key); } };
	const broker = () => new CredentialBroker(secretStore, async () => false);
	await assert.rejects(broker().getToken('chatgpt-oauth'), error => error instanceof MissingCredentialError && error.providerId === 'chatgpt-oauth');
	f.values.openaiApiKey = 'initial-api-key'; const finder = f.create(broker()); await finder.refresh();
	delete f.values.openaiApiKey;
	assert.equal(row(await finder.refresh({ force: true }), 'openai').credentialStatus, 'missing');
	f.values.openaiApiKey = 'restored-key'; await finder.refresh({ force: true }); delete f.values.openaiApiKey;
	const key = 'son-of-anton.broker.token.chatgpt-oauth';
	for (const raw of ['', '{private-malformed', 'null', '[]', '{}', JSON.stringify({ token: 'private-token', expiresAt: 'invalid' }), JSON.stringify({ token: '', expiresAt: Date.now() + 3600000 }), JSON.stringify({ token: 'private-token', expiresAt: Date.now() + 3600000, headers: { Authorization: 3 } })]) {
		tokens.set(key, raw); const real = broker();
		await assert.rejects(real.getToken('chatgpt-oauth'), error => error instanceof Error && !(error instanceof MissingCredentialError) && !error.message.includes('private-'));
		const current = row(await f.create(real).refresh(), 'openai');
		assert.deepEqual({ status: current.catalogStatus, missing: current.credentialStatus, model: current.models[0]?.model, route: providerForModel(discoveredModelId('openai', 'retained-model')) }, { status: 'error', missing: undefined, model: 'retained-model', route: 'openai' });
	}
	readFailure = true;
	const unreadable = row(await f.create(broker()).refresh(), 'openai');
	assert.deepEqual({ status: unreadable.catalogStatus, missing: unreadable.credentialStatus, model: unreadable.models[0]?.model }, { status: 'error', missing: undefined, model: 'retained-model' });
	readFailure = false; tokens.set(key, JSON.stringify({ token: 'private-expired-token', expiresAt: 1, refreshToken: 'private-refresh-token' }));
	const failingRefresh = broker(); failingRefresh.registerProvider({ id: 'chatgpt-oauth', displayName: 'Fixture', authorizationEndpoint: 'https://auth.example.test', tokenEndpoint: 'https://token.example.test', clientId: 'fixture', scopes: [] });
	const originalFetch = globalThis.fetch;
	try {
		const retainedToken = tokens.get(key);
		for (const failure of [{ status: 503, body: '' }, { status: 429, body: '' }, { status: 401, body: '{"error":"invalid_client"}' }, { status: 400, body: '{"error":"invalid_client"}' }, { status: 400, body: '{private-malformed' }, { status: 400, body: JSON.stringify({ error: 'invalid_grant', padding: 'x'.repeat(16 * 1024) }) }]) {
			globalThis.fetch = async () => new Response(failure.body, { status: failure.status });
			const retrying = f.create(failingRefresh);
			for (let attempt = 0; attempt < 2; attempt++) {
				const failed = row(await retrying.refresh({ force: true }), 'openai');
				assert.deepEqual({ status: failed.catalogStatus, missing: failed.credentialStatus, model: failed.models[0]?.model, leaked: JSON.stringify(failed).includes('private-'), stored: tokens.get(key) }, { status: 'error', missing: undefined, model: 'retained-model', leaked: false, stored: retainedToken });
			}
		}
		let cancelled = false;
		globalThis.fetch = async () => new Response(new ReadableStream({ cancel: () => { cancelled = true; } }), { status: 400 });
		const stalled = row(await f.create(failingRefresh).refresh(), 'openai');
		assert.deepEqual({ status: stalled.catalogStatus, cancelled, stored: tokens.get(key) }, { status: 'error', cancelled: true, stored: retainedToken });
		globalThis.fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
		const invalidated = f.create(failingRefresh);
		assert.equal(row(await invalidated.refresh(), 'openai').catalogStatus, 'error');
		assert.equal(tokens.get(key), undefined);
		assert.equal(row(await invalidated.refresh({ force: true }), 'openai').credentialStatus, 'missing');
	} finally { globalThis.fetch = originalFetch; }
});

test('every credential-backed HTTP provider retires only its models after confirmed credential removal', async t => {
	const f = await fixture(t); const finder = f.create();
	for (const [provider, setting] of Object.entries(settings) as Array<[keyof typeof settings, string]>) {
		f.values[setting] = 'configured-key'; f.values.zaiModels = ['configured-zai']; f.values.foundryDeployments = '{"deployment":"configured-foundry"}';
		const initial = row(await finder.refresh({ force: true }), provider); const id = discoveredModelId(provider, 'retained-model');
		assert.deepEqual({ status: initial.catalogStatus, credential: initial.credentialSource, route: providerForModel(id) }, { status: 'ready', credential: 'setting', route: provider });
		const requests = f.requests(); delete f.values[setting];
		const removed = row(await finder.refresh({ force: true }), provider);
		assert.deepEqual({ status: removed.catalogStatus, credential: removed.credentialSource, checked: removed.credentialStatus, models: removed.models, registered: getDiscoveredModel(id), requests: f.requests(), configured: [providerForModel(discoveredModelId('zai', 'configured-zai')), providerForModel(discoveredModelId('foundry', 'configured-foundry'))] }, { status: 'not-configured', credential: 'none', checked: 'missing', models: [], registered: undefined, requests, configured: ['zai', 'foundry'] });
		assert.throws(() => providerForModel(id), /Refresh/);
	}
});

for (const provider of ['anthropic', 'openai'] as const) {
	test(`${provider} keeps the catalog while credential sources fall back in priority order`, async t => {
		const f = await fixture(t); const secret = `sota.secrets.${provider === 'anthropic' ? 'anthropicApiKey' : 'openaiApiKey'}`;
		const broker = provider === 'anthropic' ? 'anthropic-oauth' : 'chatgpt-oauth'; const environment = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
		f.secretValues.set(secret, 'secret-key'); f.values[settings[provider]] = 'setting-key'; f.env[environment] = 'env-key'; f.brokers.set(broker, ' broker-token ');
		const finder = f.create();
		for (const source of ['secret-storage', 'setting', 'environment', 'broker'] as const) {
			const current = row(await finder.refresh({ force: true }), provider);
			assert.deepEqual({ source: current.credentialSource, status: current.catalogStatus, missing: current.credentialStatus, route: providerForModel(discoveredModelId(provider, 'retained-model')) }, { source, status: 'ready', missing: undefined, route: provider });
			if (source === 'secret-storage') { f.secretValues.delete(secret); } else if (source === 'setting') { delete f.values[settings[provider]]; } else if (source === 'environment') { delete f.env[environment]; } else { f.brokers.delete(broker); }
		}
		const removed = row(await finder.refresh({ force: true }), provider);
		assert.deepEqual({ source: removed.credentialSource, status: removed.catalogStatus, missing: removed.credentialStatus, registered: getDiscoveredModel(discoveredModelId(provider, 'retained-model')), requests: f.requests() }, { source: 'none', status: 'not-configured', missing: 'missing', registered: undefined, requests: 4 });
	});
}

test('credential store, configuration, broker and catalog failures preserve the last inventory with redacted errors', async t => {
	const f = await fixture(t); f.values.openaiApiKey = 'configured-key'; const finder = f.create(); await finder.refresh();
	const failures = [
		() => { f.secretValues.set('sota.secrets.openaiApiKey', new Error('private-keyring-error')); },
		() => { f.secretValues.clear(); f.values.openaiApiKey = new Error('private-setting-error'); },
		() => { delete f.values.openaiApiKey; f.brokers.set('chatgpt-oauth', new Error('private-broker-error')); },
		() => { f.brokers.set('chatgpt-oauth', '   '); },
		() => { f.brokers.clear(); f.values.openaiApiKey = 'configured-key'; f.failHttp(503); },
	];
	for (const fail of failures) {
		fail(); const current = row(await finder.refresh({ force: true }), 'openai');
		assert.deepEqual({ status: current.catalogStatus, missing: current.credentialStatus, models: current.models.map(model => model.model), route: providerForModel(discoveredModelId('openai', 'retained-model')), leaked: JSON.stringify(current).includes('private-') }, { status: 'error', missing: undefined, models: ['retained-model'], route: 'openai', leaked: false });
	}
	delete f.values.openaiApiKey; const removed = row(await finder.refresh({ force: true }), 'openai');
	assert.deepEqual({ missing: removed.credentialStatus, models: removed.models }, { missing: 'missing', models: [] });
});

test('startup refresh rechecks credentials inside persisted TTL and never resurrects a confirmed removed catalog', async t => {
	const f = await fixture(t); f.values.openaiApiKey = 'before-close';
	const initial = f.create(); await initial.refresh(); initial.dispose();
	const cachedTime = f.saved.get('sota.providerDiscovery.v1')!.updatedAt;
	assert.ok(Date.now() - cachedTime < 60 * 60 * 1000);
	delete f.values.openaiApiKey; const reopened = f.create();
	const readsBefore = f.credentialReads(); const removed = row(await reopened.refresh(), 'openai');
	assert.deepEqual({ missing: removed.credentialStatus, rechecked: f.credentialReads() > readsBefore, requests: f.requests(), registered: getDiscoveredModel(discoveredModelId('openai', 'retained-model')) }, { missing: 'missing', rechecked: true, requests: 1, registered: undefined });
	await new Promise<void>(resolve => setImmediate(resolve)); const readsAfter = f.credentialReads(); await reopened.refresh();
	assert.equal(f.credentialReads(), readsAfter, 'The in-process TTL still avoids repeated scans');
	const reopenedAgain = f.create(); assert.deepEqual(row(reopenedAgain.snapshot(), 'openai').models, []);
	f.values.openaiApiKey = 'restored-while-closed';
	const restored = row(await reopenedAgain.refresh(), 'openai');
	assert.deepEqual({ source: restored.credentialSource, status: restored.catalogStatus, route: providerForModel(discoveredModelId('openai', 'retained-model')) }, { source: 'setting', status: 'ready', route: 'openai' });
});

test('a broker error on startup preserves a cached model instead of proving sign-out', async t => {
	const f = await fixture(t); f.brokers.set('chatgpt-oauth', 'cached-broker-token');
	const initial = f.create(); await initial.refresh(); initial.dispose();
	f.brokers.set('chatgpt-oauth', new Error('private-broker-unavailable'));
	const reopened = f.create(); const retained = row(await reopened.refresh(), 'openai');
	assert.deepEqual({ status: retained.catalogStatus, missing: retained.credentialStatus, model: retained.models[0]?.model, route: providerForModel(discoveredModelId('openai', 'retained-model')), requests: f.requests() }, { status: 'error', missing: undefined, model: 'retained-model', route: 'openai', requests: 1 });
});

test('credential-free local discovery and its disabled state cannot retire retained local routes', async t => {
	const f = await fixture(t); const finder = f.create();
	const initial = await finder.refresh({ includeLocal: true });
	const disabled = await finder.refresh({ force: true, includeLocal: false });
	for (const provider of ['ollama', 'lmstudio'] as const) {
		assert.deepEqual({ initial: row(initial, provider).catalogStatus, missing: row(initial, provider).credentialStatus, disabled: row(disabled, provider).catalogStatus, disabledMissing: row(disabled, provider).credentialStatus, route: providerForModel(discoveredModelId(provider, 'retained-model')) }, { initial: 'ready', missing: undefined, disabled: 'disabled', disabledMissing: undefined, route: provider });
	}
});
