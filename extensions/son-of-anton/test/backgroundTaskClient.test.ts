/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as assert from 'assert';
import { BackgroundTaskClient } from '../src/background/BackgroundTaskClient';

suite('BackgroundTaskClient', () => {
	const originalFetch = globalThis.fetch;
	const originalToken = process.env.BACKGROUND_TASK_API_TOKEN;
	teardown(() => { globalThis.fetch = originalFetch; if (originalToken === undefined) { delete process.env.BACKGROUND_TASK_API_TOKEN; } else { process.env.BACKGROUND_TASK_API_TOKEN = originalToken; } });
	test('authenticates requests and distinguishes an unavailable service from an empty list', async () => {
		process.env.BACKGROUND_TASK_API_TOKEN = 'fixture-only';
		const client = new BackgroundTaskClient('http://127.0.0.1:8093');
		try {
			globalThis.fetch = async (_url, init) => {
				assert.strictEqual(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-only');
				assert.strictEqual(init?.redirect, 'error');
				return new Response('{}', { status: 401 });
			};
			assert.deepStrictEqual(await client.listTasks(), []);
			assert.match(client.lastListError!, /401/);
			globalThis.fetch = async () => new Response('[]', { status: 200 });
			assert.deepStrictEqual(await client.listTasks(), []);
			assert.strictEqual(client.lastListError, undefined);
		} finally { client.dispose(); }
	});
	test('cannot report cancellation success on an HTTP error', async () => {
		globalThis.fetch = async () => new Response('{"cancelled":true}', { status: 500 });
		const client = new BackgroundTaskClient();
		try { assert.strictEqual(await client.cancelTask('../invalid'), false); } finally { client.dispose(); }
	});
});
