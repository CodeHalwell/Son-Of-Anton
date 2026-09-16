// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
	SERVICE_TOKEN_ENV,
	createAuthMiddleware,
	enforceHttpAuth,
	isAuthorized,
	isExemptPath,
	requireServiceToken,
	serviceAuthHeaders,
} from '../index';

const TOKEN = 'super-secret-token';

function fakeRequest(url: string, authorization?: string): IncomingMessage {
	return { url, headers: authorization ? { authorization } : {} } as unknown as IncomingMessage;
}

interface CapturedResponse {
	res: ServerResponse;
	status: number | undefined;
	body: string | undefined;
}

function fakeResponse(): CapturedResponse {
	const captured: CapturedResponse = { res: undefined as unknown as ServerResponse, status: undefined, body: undefined };
	captured.res = {
		writeHead(status: number) {
			captured.status = status;
			return this;
		},
		end(body?: string) {
			captured.body = body;
			return this;
		},
	} as unknown as ServerResponse;
	return captured;
}

afterEach(() => {
	delete process.env[SERVICE_TOKEN_ENV];
});

describe('isExemptPath', () => {
	test('exempts health and metrics, including with query strings', () => {
		assert.deepStrictEqual(
			['/health', '/metrics', '/health?ready=1', '/metrics?x=1', '/tasks', '/'].map(isExemptPath),
			[true, true, true, true, false, false]
		);
	});
});

describe('isAuthorized', () => {
	test('accepts a matching bearer token and rejects everything else', () => {
		assert.deepStrictEqual(
			[
				isAuthorized({ authorization: `Bearer ${TOKEN}` }, TOKEN),
				isAuthorized({ authorization: `bearer ${TOKEN}` }, TOKEN),
				isAuthorized({ authorization: `Bearer ${TOKEN}x` }, TOKEN),
				isAuthorized({ authorization: `Bearer ${TOKEN}` }, 'other'),
				isAuthorized({ authorization: TOKEN }, TOKEN),
				isAuthorized({}, TOKEN),
			],
			[true, true, false, false, false, false]
		);
	});
});

describe('enforceHttpAuth', () => {
	test('exempt paths and valid tokens pass; missing configuration and mismatches get 401', () => {
		// Exempt path — no token required.
		assert.strictEqual(enforceHttpAuth(fakeRequest('/health'), fakeResponse().res, TOKEN), true);

		// Valid token.
		assert.strictEqual(enforceHttpAuth(fakeRequest('/tasks', `Bearer ${TOKEN}`), fakeResponse().res, TOKEN), true);

		// Missing server configuration must never disable authentication.
		assert.strictEqual(enforceHttpAuth(fakeRequest('/tasks'), fakeResponse().res, ''), false);

		// Missing/invalid token → 401 written.
		const captured = fakeResponse();
		assert.strictEqual(enforceHttpAuth(fakeRequest('/tasks', 'Bearer nope'), captured.res, TOKEN), false);
		assert.strictEqual(captured.status, 401);
		assert.match(captured.body ?? '', /Unauthorized/);
	});

	test('falls back to the SOTA_SERVICE_TOKEN environment variable', () => {
		process.env[SERVICE_TOKEN_ENV] = TOKEN;
		assert.strictEqual(enforceHttpAuth(fakeRequest('/tasks', `Bearer ${TOKEN}`), fakeResponse().res), true);
		assert.strictEqual(enforceHttpAuth(fakeRequest('/tasks', 'Bearer nope'), fakeResponse().res), false);
	});
});

describe('createAuthMiddleware', () => {
	function run(path: string, authorization: string | undefined, token?: string): { nexted: boolean; status: number | undefined } {
		const middleware = createAuthMiddleware(token);
		let nexted = false;
		let status: number | undefined;
		const req = { path, headers: authorization ? { authorization } : {} } as never;
		const res = { status(code: number) { status = code; return this; }, json() { return this; } } as never;
		middleware(req, res, () => { nexted = true; });
		return { nexted, status };
	}

	test('passes exempt paths and valid tokens; blocks missing configuration and mismatches', () => {
		assert.deepStrictEqual(run('/health', undefined, TOKEN), { nexted: true, status: undefined });
		assert.deepStrictEqual(run('/tasks', `Bearer ${TOKEN}`, TOKEN), { nexted: true, status: undefined });
		assert.deepStrictEqual(run('/tasks', undefined, ''), { nexted: false, status: 401 });
		assert.deepStrictEqual(run('/tasks', 'Bearer nope', TOKEN), { nexted: false, status: 401 });
	});
});

describe('serviceAuthHeaders', () => {
	test('emits a bearer header only when a token is configured', () => {
		assert.deepStrictEqual(serviceAuthHeaders(TOKEN), { Authorization: `Bearer ${TOKEN}` });
		assert.deepStrictEqual(serviceAuthHeaders(''), {});
		process.env[SERVICE_TOKEN_ENV] = TOKEN;
		assert.deepStrictEqual(serviceAuthHeaders(), { Authorization: `Bearer ${TOKEN}` });
	});
});

describe('requireServiceToken', () => {
	test('returns the configured token', () => {
		process.env[SERVICE_TOKEN_ENV] = TOKEN;
		assert.strictEqual(requireServiceToken('test-service'), TOKEN);
	});
});


test('a live HTTP server never serves protected data without configured authentication', async t => {
	const server = createServer((request, response) => {
		if (!enforceHttpAuth(request, response, '')) { return; }
		response.end('protected data');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	for (const authorization of [undefined, 'Bearer attacker-supplied']) {
		const headers: Record<string, string> = authorization ? { Authorization: authorization } : {};
		const response: Response = await fetch(`http://127.0.0.1:${address.port}/tasks`, { headers });
		assert.equal(response.status, 401);
		assert.ok(!(await response.text()).includes('protected data'));
	}
	assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
});
