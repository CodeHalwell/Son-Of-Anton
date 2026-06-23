// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FetchCall {
	abortSignal: AbortSignal;
	url: string;
}

function installMockFetch(
	handler: (url: string, init: RequestInit, signal: AbortSignal) => Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
	const calls: FetchCall[] = [];
	const original = globalThis.fetch as typeof fetch;
	globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const signal = (init?.signal as AbortSignal) ?? new AbortController().signal;
		calls.push({ url: String(url), abortSignal: signal });
		return handler(String(url), init ?? {}, signal);
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = original; } };
}

function makeAbortError(): Error {
	const e = new Error('The operation was aborted');
	e.name = 'AbortError';
	return e;
}

/**
 * Opens an HTTP SSE connection to the server, waits until the first data
 * chunk arrives, then destroys the socket to simulate a client cancel.
 * Returns the partial body received before the destroy.
 */
async function openAndDestroy(port: number, body: object): Promise<{ partial: string; signal: AbortSignal | undefined }> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		let partial = '';
		let resolved = false;
		let capturedSignal: AbortSignal | undefined;

		const req = http.request(
			{
				hostname: '127.0.0.1',
				port,
				path: '/v1/messages',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload),
					'x-agent-role': 'default',
				},
			},
			(res) => {
				res.on('data', (chunk: Buffer) => {
					partial += chunk.toString();
					if (!resolved) {
						resolved = true;
						// Capture the fetch signal, then destroy
						req.destroy();
						resolve({ partial, signal: capturedSignal });
					}
				});
			},
		);

		req.on('error', (err: NodeJS.ErrnoException) => {
			if (err.code === 'ECONNRESET' && resolved) {
				// Expected — we destroyed the socket
			} else if (!resolved) {
				reject(err);
			}
		});

		// Expose signal via closure so we can check it after destroy
		const origFetch = globalThis.fetch as typeof fetch;
		(globalThis.fetch as typeof fetch) = (async (url: string | URL | Request, init?: RequestInit) => {
			capturedSignal = init?.signal as AbortSignal;
			return origFetch(url, init);
		}) as typeof fetch;

		req.write(payload);
		req.end();
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('model-router cancellation (§10.2)', () => {
	let server: http.Server;
	let port: number;
	let restoreFetch: (() => void) | undefined;

	before(async () => {
		const app = createServer();
		server = http.createServer(app);
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		port = (server.address() as import('net').AddressInfo).port;
	});

	after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close(err => (err ? reject(err) : resolve())),
		);
	});

	afterEach(() => {
		restoreFetch?.();
		restoreFetch = undefined;
	});

	test('streaming AbortError mid-stream emits message_stop and error cancel events', async () => {
		// Mock: return a streaming body that sends one chunk then errors with AbortError.
		// This simulates what happens when the upstream provider connection resets.
		let streamPull = 0;
		const { restore } = installMockFetch(async () => {
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					streamPull++;
					if (streamPull === 1) {
						controller.enqueue(
							new TextEncoder().encode('data: {"type":"text_delta","text":"hi"}\n\n'),
						);
					} else {
						controller.error(makeAbortError());
					}
				},
			});
			return new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			});
		});
		restoreFetch = restore;

		// Collect the full SSE response
		const responseText = await new Promise<string>((resolve, reject) => {
			const payload = JSON.stringify({
				messages: [{ role: 'user', content: 'hi' }],
				stream: true,
			});
			let text = '';
			const req = http.request(
				{
					hostname: '127.0.0.1',
					port,
					path: '/v1/messages',
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(payload),
						'x-agent-role': 'default',
					},
				},
				(res) => {
					res.on('data', (c: Buffer) => { text += c.toString(); });
					res.on('end', () => resolve(text));
				},
			);
			req.on('error', reject);
			req.write(payload);
			req.end();
		});

		// The cancel events must appear in the SSE response.
		assert.ok(
			responseText.includes('"message_stop"'),
			`expected message_stop in: ${responseText.slice(0, 300)}`,
		);
		assert.ok(
			responseText.includes('"cancelled"'),
			`expected cancelled error in: ${responseText.slice(0, 300)}`,
		);
	});

	test('streaming AbortError does not fall through to next provider', async () => {
		let callCount = 0;
		let streamPull = 0;
		const { restore } = installMockFetch(async () => {
			callCount++;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					streamPull++;
					if (streamPull === 1) {
						controller.enqueue(new TextEncoder().encode('data: {}\n\n'));
					} else {
						controller.error(makeAbortError());
					}
				},
			});
			return new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			});
		});
		restoreFetch = restore;

		await new Promise<void>((resolve, reject) => {
			const payload = JSON.stringify({
				messages: [{ role: 'user', content: 'hi' }],
				stream: true,
			});
			const req = http.request(
				{
					hostname: '127.0.0.1',
					port,
					path: '/v1/messages',
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Content-Length': Buffer.byteLength(payload),
						'x-agent-role': 'default',
					},
				},
				(res) => {
					res.resume();
					res.on('end', resolve);
				},
			);
			req.on('error', reject);
			req.write(payload);
			req.end();
		});

		// A single mock fetch call: AbortError should NOT trigger failover to next provider.
		assert.strictEqual(callCount, 1, 'should call fetch exactly once — no provider failover on abort');
	});

	test('client socket close aborts the upstream fetch signal', async () => {
		let capturedSignal: AbortSignal | undefined;

		// Resolve as soon as the server-side fetch signal fires 'abort' — more
		// reliable than waiting for socket close events on the client side.
		let signalAbortResolve!: () => void;
		const signalAbortedPromise = new Promise<void>(r => { signalAbortResolve = r; });

		const { restore } = installMockFetch(async (_url, _init, signal) => {
			capturedSignal = signal;
			// Slow streaming body — never completes on its own
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					// Emit one chunk so the client receives data (triggering destroy)
					controller.enqueue(new TextEncoder().encode('data: {"type":"text_delta","text":"hello"}\n\n'));
					// Notify the test and close the stream when the signal fires
					signal.addEventListener('abort', () => {
						signalAbortResolve();
						controller.close();
					}, { once: true });
				},
			});
			return new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			});
		});
		restoreFetch = restore;

		const payload = JSON.stringify({
			messages: [{ role: 'user', content: 'hi' }],
			stream: true,
		});

		// Fire-and-forget: make the request, destroy on first chunk, ignore teardown errors
		const req = http.request(
			{
				hostname: '127.0.0.1',
				port,
				path: '/v1/messages',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(payload),
					'x-agent-role': 'default',
				},
			},
			(res) => {
				res.once('data', () => req.destroy());
				res.on('error', () => { /* socket destroyed — expected */ });
			},
		);
		req.on('error', () => { /* ECONNRESET expected after destroy */ });
		req.write(payload);
		req.end();

		// Wait until the server-side fetch signal actually aborts
		await signalAbortedPromise;

		assert.ok(capturedSignal?.aborted, 'upstream fetch AbortSignal should be aborted after client socket close');
	});
});
