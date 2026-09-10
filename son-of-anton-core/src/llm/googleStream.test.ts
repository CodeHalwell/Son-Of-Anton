/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LlmClient, type LlmStreamEvent } from './LlmClient';

for (const delimiter of ['\n\n', '\r\n\r\n', '']) {
	test(`Google streams retain fragmented UTF-8, tools and usage with ${JSON.stringify(delimiter)} framing`, async t => {
		const frame = { candidates: [{ content: { parts: [{ text: 'Hello 🌍' }, { functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'signed-fixture' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } };
		const bytes = new TextEncoder().encode(`data: ${JSON.stringify(frame)}${delimiter}`);
		t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } })));
		const llm = new LlmClient({ get: async () => 'fixture-key', store: async () => {}, delete: async () => {} }, { get: <T>(_key: string, fallback?: T) => fallback as T });
		const events: LlmStreamEvent[] = [];
		for await (const event of llm.streamRequest({ model: 'gemini-2-5-pro', systemPrompt: 'Fixture', messages: [{ role: 'user', content: 'Hello' }] })) events.push(event);
		assert.deepEqual(events.map(event => event.type === 'tool-call' ? { ...event, id: 'generated-id' } : event), [
			{ type: 'token', token: 'Hello 🌍' },
			{ type: 'tool-call', id: 'generated-id', name: 'read_file', input: { path: 'README.md' }, thoughtSignature: 'signed-fixture' },
			{ type: 'complete', fullText: 'Hello 🌍', inputTokens: 12, outputTokens: 7, cachedTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, stopReason: 'tool_use' },
		]);
	});
}

for (const payload of ['', '{invalid', JSON.stringify({ error: { message: 'private server details' } }), JSON.stringify({ promptFeedback: { blockReason: 'OTHER' } }), JSON.stringify({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] })]) {
	test(`Google empty or unsuccessful stream cannot report success: ${payload.slice(0, 50)}`, async t => {
		t.mock.method(globalThis, 'fetch', async () => new Response(`data: ${payload}\r\n\r\n`));
		const llm = new LlmClient({ get: async () => 'fixture-key', store: async () => {}, delete: async () => {} }, { get: <T>(_key: string, fallback?: T) => fallback as T });
		const events: LlmStreamEvent[] = [];
		for await (const event of llm.streamRequest({ model: 'gemini-2-5-pro', systemPrompt: 'Fixture', messages: [{ role: 'user', content: 'Hello' }] })) events.push(event);
		assert.deepEqual(events.map(event => event.type), ['error']);
		assert.doesNotMatch(JSON.stringify(events), /private server details/);
	});
}
