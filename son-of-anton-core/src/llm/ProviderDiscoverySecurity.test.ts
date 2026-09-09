/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ProviderDiscovery } from './ProviderDiscovery';

const secrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };
async function listen(t: TestContext, handler: RequestListener): Promise<string> {
	const server = createServer(handler);
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
	const address = server.address(); assert.ok(address && typeof address === 'object');
	return `http://127.0.0.1:${address.port}`;
}
async function homeDirectory(t: TestContext): Promise<string> {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-provider-security-'));
	t.after(() => rm(home, { recursive: true, force: true }));
	return home;
}

test('catalog GET sends only the intended provider credential, never discovered file bodies or private tool settings', async t => {
	const home = await homeDirectory(t);
	await mkdir(path.join(home, '.claude'));
	await writeFile(path.join(home, '.claude/settings.json'), JSON.stringify({ model: 'sonnet', env: { OPENAI_API_KEY: 'unrelated-tool-secret' }, privateDocument: 'private-file-sentinel' }));
	const requests: Array<{ method?: string; url?: string; authorization?: string; body: string }> = [];
	const endpoint = await listen(t, (request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
			response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'gpt-fixture' }] }));
		});
	});
	const settingsFile = path.join(home, 'user-config.json');
	await writeFile(settingsFile, JSON.stringify({ openaiBaseUrl: `${endpoint}/v1`, openaiApiKey: 'intended-provider-key', unrelatedSetting: 'private-file-sentinel' }));
	const settings: Record<string, string> = JSON.parse(await readFile(settingsFile, 'utf8'));
	const finder = new ProviderDiscovery({ home, env: { PATH: '' }, secrets, config: { get: <T>(key: string, fallback?: T) => (settings[key] ?? fallback) as T } });
	t.after(() => finder.dispose());
	const snapshot = await finder.refresh();
	assert.deepEqual(requests, [{ method: 'GET', url: '/v1/models', authorization: 'Bearer intended-provider-key', body: '' }]);
	assert.equal(snapshot.providers.find(provider => provider.id === 'openai')?.catalogStatus, 'ready');
	assert.doesNotMatch(JSON.stringify(snapshot), /intended-provider-key|unrelated-tool-secret|private-file-sentinel/);
});

test('catalog redirects never forward a provider credential to another endpoint', async t => {
	const home = await homeDirectory(t); let redirectedRequests = 0;
	const target = await listen(t, (_request, response) => { redirectedRequests++; response.end('{}'); });
	const endpoint = await listen(t, (_request, response) => { response.writeHead(302, { Location: `${target}/collect` }); response.end(); });
	const finder = new ProviderDiscovery({ home, env: { PATH: '', OPENAI_API_KEY: 'redirect-private-key' }, secrets, config: { get: <T>(key: string, fallback?: T) => (key === 'openaiBaseUrl' ? `${endpoint}/v1` : fallback) as T } });
	t.after(() => finder.dispose());
	const snapshot = await finder.refresh();
	assert.deepEqual({ redirectedRequests, status: snapshot.providers.find(provider => provider.id === 'openai')?.catalogStatus }, { redirectedRequests: 0, status: 'error' });
	assert.doesNotMatch(JSON.stringify(snapshot), /redirect-private-key|\/collect/);
});
