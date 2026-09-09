/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LlmClient, type LlmStreamEvent } from './LlmClient';
import { ProviderDiscovery, type DiscoveredProvider } from './ProviderDiscovery';
import { detectCredentials } from '../credentials/credentialDetection';
import type { ConfigStore, SecretStore } from '../host';
import type { CredentialBroker } from '../auth/CredentialBroker';

const aliases = {
	together: ['TOGETHER_API_KEY', 'TOGETHERAI_API_KEY'],
	lmstudio: ['LMSTUDIO_API_KEY', 'LM_API_TOKEN'],
} as const;
type Provider = keyof typeof aliases;
interface Credentials { primary?: string; alternate?: string; setting?: string; secret?: string; expected?: string; source: DiscoveredProvider['credentialSource'] }
const configuration = (settings: Record<string, unknown>): ConfigStore => ({ get: <T>(key: string, fallback?: T): T => (settings[key] ?? fallback) as T });

async function exercise(t: TestContext, provider: Provider, credentials: Credentials): Promise<void> {
	const environment: NodeJS.ProcessEnv = { PATH: '' };
	const saved = new Map(Object.values(aliases).flat().map(key => [key, process.env[key]]));
	for (const key of saved.keys()) { delete process.env[key]; }
	for (const [key, value] of [[aliases[provider][0], credentials.primary], [aliases[provider][1], credentials.alternate]] as const) {
		if (value !== undefined) { process.env[key] = value; environment[key] = value; }
	}
	t.after(() => { for (const [key, value] of saved) { if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; } } });
	const home = await mkdtemp(path.join(os.tmpdir(), 'sota-credential-alias-'));
	t.after(() => rm(home, { recursive: true, force: true }));
	const setting = `${provider}ApiKey`;
	const secrets: SecretStore = { get: async key => key === `sota.secrets.${setting}` ? credentials.secret : undefined, store: async () => {}, delete: async () => {} };
	const base = provider === 'together' ? 'https://alias-provider.invalid/v1' : 'http://127.0.0.1:1234';
	const origin = new URL(base).origin;
	const config = configuration({ [setting]: credentials.setting, [`${provider}BaseUrl`]: base });
	const rawModel = `${provider}/alias-contract-model`;
	const requests: Array<{ path: string; auth: string | null }> = [];
	const request: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		// Explicit local discovery also visits Ollama; keep that unrelated server empty.
		if (url.origin === 'http://localhost:11434' && url.pathname === '/api/tags') { return Response.json({ models: [] }); }
		assert.equal(url.origin, origin);
		const auth = new Headers(init?.headers).get('authorization');
		requests.push({ path: url.pathname, auth });
		assert.equal(auth, credentials.expected ? `Bearer ${credentials.expected}` : null);
		if (init?.method === 'POST') {
			assert.equal(url.pathname, '/v1/chat/completions');
			assert.equal(JSON.parse(String(init.body)).model, rawModel);
			return new Response('data: {"choices":[{"delta":{"content":"Authenticated answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
		}
		assert.equal(url.pathname, provider === 'together' ? '/v1/models' : '/api/v1/models');
		return Response.json(provider === 'together' ? { data: [{ id: rawModel, type: 'chat' }] } : { models: [{ key: rawModel, type: 'llm' }] });
	};
	t.mock.method(globalThis, 'fetch', request);
	const discovery = new ProviderDiscovery({ home, env: environment, secrets, config, request });
	t.after(() => discovery.dispose());
	const snapshot = await discovery.refresh({ includeLocal: provider === 'lmstudio' });
	const discovered = snapshot.providers.find(candidate => candidate.id === provider)!;
	assert.equal(discovered.catalogStatus, 'ready');
	assert.equal(discovered.credentialSource, credentials.source);
	assert.equal(discovered.models.length, 1);
	const client = new LlmClient(secrets, config);
	const events: LlmStreamEvent[] = [];
	for await (const event of client.streamRequest({ model: discovered.models[0].id, messages: [{ role: 'user', content: 'Use the discovered model' }], maxRetries: 0 })) { events.push(event); }
	assert.deepEqual(events.filter(event => event.type === 'error'), []);
	assert.equal(events.filter(event => event.type === 'token').map(event => event.token).join(''), 'Authenticated answer');
	assert.deepEqual(requests.map(entry => entry.path), [provider === 'together' ? '/v1/models' : '/api/v1/models', '/v1/chat/completions']);
	const state = await detectCredentials(secrets, configuration({ [setting]: credentials.setting }), { status: async () => [] } as unknown as CredentialBroker, { environment, isCodexAvailable: () => false });
	assert.equal(provider === 'together' ? state.together.hasApiKey : state.lmstudio.hasBaseUrl, !!credentials.expected, 'provider status must recognize the same credential without relying on an explicit endpoint');
}

for (const provider of ['together', 'lmstudio'] as const) {
	for (const [name, credentials] of [
		['primary environment key', { primary: ' primary-fixture ', expected: 'primary-fixture', source: 'environment' }],
		['alternate environment key', { alternate: ' alternate-fixture ', expected: 'alternate-fixture', source: 'environment' }],
		['blank primary falls back to alternate', { primary: ' ', alternate: ' alternate-fixture ', expected: 'alternate-fixture', source: 'environment' }],
		['primary precedes alternate', { primary: 'primary-fixture', alternate: 'alternate-fixture', expected: 'primary-fixture', source: 'environment' }],
		['settings precede environment', { primary: 'primary-fixture', alternate: 'alternate-fixture', setting: ' settings-fixture ', expected: 'settings-fixture', source: 'setting' }],
		['secrets precede settings and environment', { primary: 'primary-fixture', alternate: 'alternate-fixture', setting: 'settings-fixture', secret: ' secret-fixture ', expected: 'secret-fixture', source: 'secret-storage' }],
	] satisfies Array<[string, Credentials]>) {
		test(`${provider}: discovery and inference agree on ${name}`, async t => exercise(t, provider, credentials));
	}
}

test('LM Studio preserves anonymous local inference without credentials', async t => exercise(t, 'lmstudio', { source: 'none' }));
