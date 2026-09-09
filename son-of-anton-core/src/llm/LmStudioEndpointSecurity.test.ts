/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { ConfigStore, SecretStore } from '../host';
import { LlmClient, type LlmStreamEvent, type ModelId } from './LlmClient';
import { discoveredModelId, registerDiscoveredModels } from './DiscoveredModels';

const token = 'lmstudio-private-fixture-token';
const discovered = discoveredModelId('lmstudio', 'endpoint-security-fixture');
const routes: ModelId[] = ['lmstudio-loaded', discovered];
registerDiscoveredModels([{ id: discovered, provider: 'lmstudio', model: 'endpoint-security-fixture', label: 'Endpoint fixture', chat: true, tools: false, images: false, fetchedAt: 1 }]);
const response = () => new Response('data: {"choices":[{"delta":{"content":"Allowed answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

function environment(t: TestContext): void {
	for (const name of ['LMSTUDIO_API_KEY', 'LM_API_TOKEN']) {
		const previous = process.env[name]; delete process.env[name];
		t.after(() => { if (previous === undefined) { delete process.env[name]; } else { process.env[name] = previous; } });
	}
}
function secrets(value?: string): SecretStore { return { get: async key => key === 'sota.secrets.lmstudioApiKey' ? value : undefined, store: async () => {}, delete: async () => {} }; }
function configuration(user: Record<string, unknown>, workspace: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}): ConfigStore {
	return {
		get: <T>(key: string, fallback?: T) => (workspace[key] ?? user[key] ?? defaults[key] ?? fallback) as T,
		inspect: <T>(key: string) => ({ globalValue: user[key] as T | undefined, defaultValue: defaults[key] as T | undefined }),
	};
}
async function run(client: LlmClient, model: ModelId = 'lmstudio-loaded'): Promise<LlmStreamEvent[]> {
	const events: LlmStreamEvent[] = [];
	for await (const event of client.streamRequest({ model, messages: [{ role: 'user', content: 'Explain this file' }], maxRetries: 0, signal: AbortSignal.timeout(3000) })) { events.push(event); }
	return events;
}
function denied(events: LlmStreamEvent[]): void {
	assert.equal(events.length, 1);
	assert.equal(events[0].type, 'error');
	assert.match(events[0].type === 'error' ? events[0].error : '', /LM Studio credentials require an endpoint configured in user settings/);
	assert.doesNotMatch(JSON.stringify(events), /lmstudio-private-fixture-token|untrusted\.invalid|trusted\.invalid/);
}
function allowed(events: LlmStreamEvent[]): void {
	assert.deepEqual(events.filter(event => event.type === 'error'), []);
	assert.equal(events.filter(event => event.type === 'token').map(event => event.token).join(''), 'Allowed answer');
}

for (const source of ['secret', 'setting', 'LMSTUDIO_API_KEY', 'LM_API_TOKEN']) {
	test(`LM Studio binds ${source} credentials before direct or discovered inference`, async t => {
		environment(t);
		if (source === 'LMSTUDIO_API_KEY' || source === 'LM_API_TOKEN') { process.env[source] = token; }
		const user: Record<string, unknown> = { lmstudioBaseUrl: 'https://trusted.invalid/server', ...(source === 'setting' ? { lmstudioApiKey: token } : {}) };
		const workspace = { lmstudioBaseUrl: 'https://untrusted.invalid/server' };
		const client = new LlmClient(secrets(source === 'secret' ? token : undefined), configuration(user, workspace));
		let requests = 0;
		t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requests++;
			assert.equal(new URL(String(input)).href, 'https://untrusted.invalid/server/v1/chat/completions');
			assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
			assert.equal(init?.redirect, 'error');
			return response();
		});
		for (const route of routes) { denied(await run(client, route)); }
		assert.equal(requests, 0);
		user.lmstudioBaseUrl = workspace.lmstudioBaseUrl;
		for (const route of routes) { allowed(await run(client, route)); }
		assert.equal(requests, 2);
		user.lmstudioBaseUrl = 'https://trusted.invalid/server';
		denied(await run(client));
		assert.equal(requests, 2, 'Binding is checked again after user configuration changes');
	});
}

test('LM Studio binding compares the full canonical base and treats absent inspection values as the fixed default', async t => {
	environment(t);
	const user = { lmstudioBaseUrl: 'HTTPS://TRUSTED.INVALID:443/server/' };
	const workspace = { lmstudioBaseUrl: 'https://trusted.invalid/server' };
	const client = new LlmClient(secrets(token), configuration(user, workspace));
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return response(); });
	allowed(await run(client));
	for (const endpoint of ['https://trusted.invalid/other', 'http://trusted.invalid/server', 'https://trusted.invalid:8443/server', 'https://trusted.invalid/server?tenant=other', 'https://trusted.invalid/server#other', 'https://trusted.invalid.attacker.invalid/server', 'not a URL']) {
		workspace.lmstudioBaseUrl = endpoint; denied(await run(client));
	}
	assert.equal(requests, 1);
	const missing = configuration({}, { lmstudioBaseUrl: 'https://untrusted.invalid' });
	missing.inspect = () => undefined;
	denied(await run(new LlmClient(secrets(token), missing)));
	assert.equal(requests, 1);
	allowed(await run(new LlmClient(secrets(token), configuration({}, { lmstudioBaseUrl: 'http://localhost:1234/' }))));
	allowed(await run(new LlmClient(secrets(token), configuration({}, { lmstudioBaseUrl: 'https://trusted.invalid/default' }, { lmstudioBaseUrl: 'https://trusted.invalid/default/' }))));
	assert.equal(requests, 3);
});

test('inherited arbitrary custom headers are bound even without an API key and are materialized once', async t => {
	environment(t);
	for (const name of ['Authorization', 'x-api-key', 'Cookie', 'X-Private-Proxy-Key']) {
		const user: Record<string, unknown> = { lmstudioBaseUrl: 'https://trusted.invalid/server', lmstudioCustomHeaders: JSON.stringify({ [name]: token }) };
		const workspace = { lmstudioBaseUrl: 'https://untrusted.invalid/server' };
		const config = configuration(user, workspace);
		const get = config.get.bind(config); let headerReads = 0;
		config.get = <T>(key: string, fallback?: T): T => {
			if (key === 'lmstudioCustomHeaders') { headerReads++; }
			return get(key, fallback as T);
		};
		const client = new LlmClient(secrets(), config); let requests = 0;
		const mock = t.mock.method(globalThis, 'fetch', async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requests++; assert.equal(new Headers(init?.headers).get(name), token); assert.equal(init?.redirect, 'error'); return response();
		});
		denied(await run(client, discovered));
		assert.deepEqual([requests, headerReads], [0, 1]);
		user.lmstudioBaseUrl = workspace.lmstudioBaseUrl;
		allowed(await run(client, discovered));
		assert.deepEqual([requests, headerReads], [1, 2]);
		mock.mock.restore();
	}
});

test('anonymous workspace endpoints and credential-bearing single-scope CLI settings remain usable', async t => {
	environment(t);
	const user = { lmstudioBaseUrl: 'https://trusted.invalid' };
	const workspace = { lmstudioBaseUrl: 'https://workspace.invalid' };
	const requests: Array<{ url: string; auth: string | null; redirect?: RequestInit['redirect'] }> = [];
	t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		requests.push({ url: new URL(String(input)).href, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect }); return response();
	});
	const anonymous = new LlmClient(secrets(), configuration(user, workspace));
	for (const route of routes) { allowed(await run(anonymous, route)); }
	const cli = configuration({ lmstudioBaseUrl: 'https://cli-user.invalid/server' }); delete cli.inspect;
	allowed(await run(new LlmClient(secrets(token), cli)));
	assert.deepEqual(requests, [
		...routes.map(() => ({ url: 'https://workspace.invalid/v1/chat/completions', auth: null, redirect: undefined })),
		{ url: 'https://cli-user.invalid/server/v1/chat/completions', auth: `Bearer ${token}`, redirect: 'error' },
	]);
});

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
	const address = server.address(); assert.ok(address && typeof address === 'object');
	return `http://127.0.0.1:${address.port}`;
}

for (const redirect of ['same-origin', 'cross-origin']) {
	test(`LM Studio rejects ${redirect} redirects without forwarding bearer or custom credentials`, async t => {
		environment(t); let redirected = 0, initial = 0;
		const target = await listen(t, (request, result) => { request.resume(); redirected++; result.end('Unexpected credential receiver'); });
		const endpoint = await listen(t, (request, result) => {
			request.resume();
			if (request.url !== '/approved/v1/chat/completions') { redirected++; result.end('Unexpected path'); return; }
			initial++;
			assert.equal(request.headers.authorization, `Bearer ${token}`);
			assert.equal(request.headers['x-private-proxy-key'], token);
			result.writeHead(307, { Location: redirect === 'same-origin' ? '/other/collect' : `${target}/collect` }); result.end();
		});
		const client = new LlmClient(secrets(token), configuration({ lmstudioBaseUrl: `${endpoint}/approved`, lmstudioCustomHeaders: JSON.stringify({ 'X-Private-Proxy-Key': token }) }));
		const events = await run(client, discovered);
		assert.equal(events.filter(event => event.type === 'error').length, 1);
		assert.deepEqual([initial, redirected], [1, 0]);
		assert.doesNotMatch(JSON.stringify(events), /lmstudio-private-fixture-token|\/collect/);
	});
}
