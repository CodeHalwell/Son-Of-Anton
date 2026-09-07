/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { createServer } from '../src/server.js';
import { writeResponse } from '../src/responseWriter.js';
import { toAnthropicFormat, toOpenAIFormat } from '../src/translators.js';
import { buildChatGPTRequest } from '../src/providers/chatgpt-oauth.js';
import { normalizeMessages } from '../src/messageContract.js';
import type { ModelRoutesConfig } from '../src/types.js';

const clientFetch = globalThis.fetch;
const config: ModelRoutesConfig = {
	providers: { first: { baseUrl: 'https://first.test/v1/', format: 'openai', apiKey: 'fixture' }, second: { baseUrl: 'https://second.test', format: 'openai', apiKey: 'fixture' } },
	routes: [{ name: 'fixture', priority: 0, match: { agentRole: '*' }, provider: 'first', model: 'gpt-4o', fallbacks: [{ provider: 'second', model: 'gpt-4o-mini' }] }],
};
async function fixture(t: TestContext, upstream: typeof fetch, timeoutMs = 1000) {
	globalThis.fetch = upstream;
	t.after(() => { globalThis.fetch = clientFetch; });
	const server = httpServer(createServer({ config, failover: {}, timeoutMs }));
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const url = `http://127.0.0.1:${address.port}`;
	return {
		post: (body: object, endpoint = '/v1/messages') => clientFetch(url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
		metrics: async () => (await clientFetch(url + '/metrics/recent')).json() as Promise<Array<{ success: boolean; inputTokens: number; outputTokens: number; cachedTokens: number }>>,
	};
}
const request = { messages: [{ role: 'user', content: 'Hello' }], stream: true };
const sse = (data: object): string => 'data: ' + JSON.stringify(data) + '\n\n';

test('HTTP stream records usage once and retries only before output', async t => {
	const urls: string[] = [];
	const app = await fixture(t, async url => {
		urls.push(String(url));
		if (urls.length === 1) { return new Response('', { status: 503 }); }
		return new Response(sse({ choices: [{ delta: { content: 'Hello' } }] }) + sse({ usage: { prompt_tokens: 30, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 10 } } }) + 'data: [DONE]\n\n');
	});
	assert.match(await (await app.post(request)).text(), /Hello/);
	assert.deepEqual(urls, ['https://first.test/v1/chat/completions', 'https://second.test/v1/chat/completions']);
	const metrics = await app.metrics();
	assert.equal(metrics.length, 1);
	assert.deepEqual([metrics[0].success, metrics[0].inputTokens, metrics[0].outputTokens, metrics[0].cachedTokens], [true, 30, 7, 10]);
});

test('partial stream failure preserves usage and never calls a fallback', async t => {
	let calls = 0;
	const app = await fixture(t, async () => {
		calls++;
		let sent = false;
		return new Response(new ReadableStream({ pull(controller) {
			if (sent) { controller.error(new Error('Connection reset')); return; }
			sent = true;
			controller.enqueue(new TextEncoder().encode(sse({ usage: { prompt_tokens: 30, completion_tokens: 2 } }) + sse({ choices: [{ delta: { content: 'Partial' } }] })));
		} }));
	});
	const text = await (await app.post(request)).text();
	assert.match(text, /Partial/);
	assert.match(text, /provider_error/);
	assert.equal(calls, 1);
	const metrics = await app.metrics();
	assert.deepEqual([metrics.length, metrics[0].success, metrics[0].inputTokens, metrics[0].outputTokens], [1, false, 30, 2]);
});

test('deadline aborts a stalled upstream and completes with 504', async t => {
	let calls = 0;
	const app = await fixture(t, async (_url, init) => {
		calls++;
		return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
	}, 30);
	const response = await app.post(request);
	assert.equal(response.status, 504);
	assert.match(await response.text(), /timed out/);
	assert.equal(calls, 1);
	assert.equal((await app.metrics()).length, 1);
});

test('tools round trip through Anthropic, OpenAI and Responses contracts', () => {
	const messages = [
		{ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
		{ role: 'tool', content: 'export const a = 1', tool_call_id: 'call-1' },
	];
	const openai = toOpenAIFormat(messages, undefined, 512, 'fixture');
	assert.equal(openai.messages[0].tool_calls?.[0].id, 'call-1');
	assert.equal(openai.messages[1].tool_call_id, 'call-1');
	const anthropic = toAnthropicFormat(messages, undefined, 512, 'fixture');
	assert.deepEqual(JSON.parse(JSON.stringify(anthropic.messages)), [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'export const a = 1' }] }]);
	const responses = buildChatGPTRequest({ requestId: 'fixture', model: 'fixture', messages: normalizeMessages(messages) });
	assert.deepEqual(responses.input.map(item => item.type), ['function_call', 'function_call_output']);
	assert.throws(() => normalizeMessages([{ ...messages[0], tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: 'not JSON' } }] }]));
});

test('normalized HTTP endpoint uses the provider registry and rejects malformed tools', async t => {
	let calls = 0;
	const app = await fixture(t, async (_url, init) => {
		calls++;
		assert.equal(JSON.parse(String(init?.body)).tools[0].function.name, 'read_file');
		return new Response(sse({ model: 'gpt-4o', choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }) + sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }) + 'data: [DONE]\n\n');
	});
	const response = await app.post({ ...request, tools: [{ name: 'read_file', input_schema: { type: 'object' } }] }, '/v1/agent-events');
	const events = (await response.text()).trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
	assert.deepEqual(events.map(event => event.type), ['message_start', 'text_delta', 'usage', 'message_stop']);
	assert.equal(events[0].provider, 'first');
	assert.equal((await app.metrics())[0].success, true);
	assert.equal((await app.post({ ...request, tools: [{ name: 'bad' }] })).status, 400);
	assert.equal(calls, 1);
});

test('slow consumers block writes until drain, cancellation removes listeners', async () => {
	class SlowResponse extends EventEmitter { destroyed = false; write() { return false; } }
	const response = new SlowResponse();
	const abort = new AbortController();
	let completed = false;
	const writing = writeResponse(response as unknown as ServerResponse, 'data', abort.signal).then(() => { completed = true; });
	await Promise.resolve();
	assert.equal(completed, false);
	response.emit('drain');
	await writing;
	const cancelled = writeResponse(response as unknown as ServerResponse, 'data', abort.signal);
	abort.abort();
	await assert.rejects(cancelled, { name: 'AbortError' });
	assert.equal(response.eventNames().length, 0);
});
