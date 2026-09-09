/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { ConfigStore } from '../host';
import { LlmClient, type LlmStreamEvent, type ModelId } from './LlmClient';
import { discoveredModelId, registerDiscoveredModels } from './DiscoveredModels';

const token = 'ollama-private-fixture-token';
const discovered = discoveredModelId('ollama', 'endpoint-security-fixture');
const routes: ModelId[] = ['ollama-qwen-2-5-coder', discovered];
registerDiscoveredModels([{ id: discovered, provider: 'ollama', model: 'endpoint-security-fixture', label: 'Endpoint fixture', chat: true, tools: false, images: false, fetchedAt: 1 }]);
const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
const response = () => new Response('data: {"choices":[{"delta":{"content":"Allowed answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

function configuration(user: Record<string, unknown>, workspace: Record<string, unknown> = {}, defaults: Record<string, unknown> = {}): ConfigStore {
	return {
		get: <T>(key: string, fallback?: T) => (workspace[key] ?? user[key] ?? defaults[key] ?? fallback) as T,
		inspect: <T>(key: string) => ({ globalValue: user[key] as T | undefined, defaultValue: defaults[key] as T | undefined }),
	};
}
async function run(config: ConfigStore, model: ModelId = routes[0]): Promise<LlmStreamEvent[]> {
	const events: LlmStreamEvent[] = [];
	for await (const event of new LlmClient(secrets, config).streamRequest({ model, messages: [{ role: 'user', content: 'Explain this file' }], maxRetries: 0, signal: AbortSignal.timeout(3000) })) { events.push(event); }
	return events;
}
function denied(events: LlmStreamEvent[]): void {
	assert.equal(events.length, 1);
	assert.equal(events[0].type, 'error');
	assert.match(events[0].type === 'error' ? events[0].error : '', /Ollama credentials require an endpoint configured in user settings/);
	assert.doesNotMatch(JSON.stringify(events), /ollama-private-fixture-token|untrusted\.invalid|trusted\.invalid/);
}
function allowed(events: LlmStreamEvent[]): void {
	assert.deepEqual(events.filter(event => event.type === 'error'), []);
	assert.equal(events.filter(event => event.type === 'token').map(event => event.token).join(''), 'Allowed answer');
}

test('Ollama binds arbitrary inherited headers before static or discovered inference and captures them once', async t => {
	for (const name of ['Authorization', 'x-api-key', 'Cookie', 'X-Private-Proxy-Key']) {
		const user = { ollamaBaseUrl: 'https://trusted.invalid/server', ollamaCustomHeaders: JSON.stringify({ [name]: token }) };
		const workspace = { ollamaBaseUrl: 'https://untrusted.invalid/server' };
		const config = configuration(user, workspace), get = config.get.bind(config);
		let requests = 0, headerReads = 0;
		config.get = <T>(key: string, fallback?: T): T => { if (key === 'ollamaCustomHeaders') { headerReads++; } return get(key, fallback as T); };
		const mock = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requests++;
			assert.equal(new URL(String(input)).href, 'https://untrusted.invalid/server/v1/chat/completions');
			assert.equal(new Headers(init?.headers).get(name), token);
			assert.equal(init?.redirect, 'error');
			return response();
		});
		for (const route of routes) { denied(await run(config, route)); }
		assert.deepEqual([requests, headerReads], [0, 2]);
		user.ollamaBaseUrl = workspace.ollamaBaseUrl;
		for (const route of routes) { allowed(await run(config, route)); }
		assert.deepEqual([requests, headerReads], [2, 4]);
		user.ollamaBaseUrl = 'https://trusted.invalid/server';
		denied(await run(config));
		assert.deepEqual([requests, headerReads], [2, 5]);
		mock.mock.restore();
	}
});

test('Ollama compares the full canonical endpoint including path, port, scheme and query', async t => {
	const user = { ollamaBaseUrl: 'HTTPS://TRUSTED.INVALID:443/server/', ollamaCustomHeaders: JSON.stringify({ Authorization: token }) };
	const workspace = { ollamaBaseUrl: 'https://trusted.invalid/server' };
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return response(); });
	const config = configuration(user, workspace);
	allowed(await run(config));
	for (const base of ['https://trusted.invalid/other', 'http://trusted.invalid/server', 'https://trusted.invalid:8443/server', 'https://trusted.invalid/server?tenant=other', 'https://trusted.invalid/server#other', 'https://trusted.invalid.attacker.invalid/server', 'not a URL']) {
		workspace.ollamaBaseUrl = base;
		for (const route of routes) { denied(await run(config, route)); }
	}
	assert.equal(requests, 1);
});

test('Ollama missing inspection falls back to the fixed local default, and declared defaults remain supported', async t => {
	const user = { ollamaCustomHeaders: JSON.stringify({ 'X-Private-Proxy-Key': token }) };
	const workspace = { ollamaBaseUrl: 'https://untrusted.invalid/server' };
	const config = configuration(user, workspace); config.inspect = () => undefined;
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return response(); });
	denied(await run(config)); assert.equal(requests, 0);
	workspace.ollamaBaseUrl = 'http://localhost:11434/'; allowed(await run(config));
	workspace.ollamaBaseUrl = 'https://trusted.invalid/default';
	allowed(await run(configuration(user, workspace, { ollamaBaseUrl: 'https://trusted.invalid/default/' }), discovered));
	assert.equal(requests, 2);
});

test('anonymous Ollama workspace endpoints stay usable without re-reading custom headers', async t => {
	const config = configuration({ ollamaBaseUrl: 'https://trusted.invalid' }, { ollamaBaseUrl: 'https://workspace.invalid' });
	const get = config.get.bind(config); let headerReads = 0;
	config.get = <T>(key: string, fallback?: T): T => {
		if (key === 'ollamaCustomHeaders') { headerReads++; return (headerReads % 2 === 1 ? '' : JSON.stringify({ Authorization: token })) as T; }
		return get(key, fallback as T);
	};
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		requests++;
		assert.equal(new URL(String(input)).href, 'https://workspace.invalid/v1/chat/completions');
		assert.equal(new Headers(init?.headers).get('authorization'), null);
		assert.equal(init?.redirect, undefined);
		return response();
	});
	for (const route of routes) { headerReads = 0; allowed(await run(config, route)); assert.equal(headerReads, 1); }
	assert.equal(requests, 2);
});

test('authenticated Ollama single-scope CLI configuration remains usable and rejects redirects', async t => {
	const config = configuration({ ollamaBaseUrl: 'https://cli-user.invalid/server', ollamaCustomHeaders: JSON.stringify({ Authorization: token }) });
	delete config.inspect;
	let requests = 0;
	t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		requests++;
		assert.equal(new URL(String(input)).href, 'https://cli-user.invalid/server/v1/chat/completions');
		assert.equal(new Headers(init?.headers).get('authorization'), token);
		assert.equal(init?.redirect, 'error');
		return response();
	});
	for (const route of routes) { allowed(await run(config, route)); }
	assert.equal(requests, 2);
});

async function listen(t: TestContext, handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
	const address = server.address(); assert.ok(address && typeof address === 'object');
	return `http://127.0.0.1:${address.port}`;
}

for (const redirect of ['same-origin', 'cross-origin']) {
	test(`Ollama refuses ${redirect} redirects without forwarding custom credentials`, async t => {
		let redirected = 0, initial = 0;
		const target = await listen(t, (request, result) => { request.resume(); redirected++; result.end('Unexpected credential receiver'); });
		const endpoint = await listen(t, (request, result) => {
			request.resume();
			if (request.url !== '/approved/v1/chat/completions') { redirected++; result.end('Unexpected path'); return; }
			initial++;
			assert.equal(request.headers.authorization, token);
			assert.equal(request.headers['x-private-proxy-key'], token);
			result.writeHead(307, { Location: redirect === 'same-origin' ? '/other/collect' : `${target}/collect` }); result.end();
		});
		const config = configuration({ ollamaBaseUrl: `${endpoint}/approved`, ollamaCustomHeaders: JSON.stringify({ Authorization: token, 'X-Private-Proxy-Key': token }) });
		for (const route of routes) {
			const events = await run(config, route);
			assert.equal(events.filter(event => event.type === 'error').length, 1);
			assert.doesNotMatch(JSON.stringify(events), /ollama-private-fixture-token|\/collect/);
		}
		assert.deepEqual([initial, redirected], [2, 0]);
	});
}
