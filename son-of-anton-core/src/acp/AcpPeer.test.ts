/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { AcpPeer } from './AcpPeer';
import { AcpError } from './protocol';

test('peer handles reverse requests with the same id while a forward request is pending', async t => {
	const left = new PassThrough(), right = new PassThrough();
	const client = new AcpPeer(left, right, { request: async () => 'permission-granted' });
	const server: AcpPeer = new AcpPeer(right, left, { request: async (): Promise<unknown> => server.request('permission') });
	t.after(() => { client.dispose(); server.dispose(); });
	assert.equal(await client.request('prompt'), 'permission-granted');
	assert.equal(client.pendingCount, 0);
});
test('peer rejects protocol errors and aborts without leaking pending request state', async t => {
	const left = new PassThrough(), right = new PassThrough();
	const client = new AcpPeer(left, right);
	const server = new AcpPeer(right, left, { request: async method => { if (method === 'error') { throw new AcpError(-32602, 'bad params'); } return new Promise(() => {}); } });
	t.after(() => { client.dispose(); server.dispose(); });
	await assert.rejects(client.request('error'), /bad params/);
	const controller = new AbortController();
	const request = client.request('pending', {}, { signal: controller.signal }); controller.abort();
	await assert.rejects(request, /cancelled/);
	await assert.rejects(client.request('timeout', {}, { timeoutMs: 10 }), /timed out/);
	assert.equal(client.pendingCount, 0);
});
test('peer reports malformed JSON and validates ids while continuing valid requests', async t => {
	const input = new PassThrough(), output = new PassThrough(); let frames = '';
	output.on('data', chunk => { frames += chunk; });
	const peer = new AcpPeer(input, output, { request: async () => ({ ok: true }) }); t.after(() => peer.dispose());
	input.write('not json\n{"jsonrpc":"2.0","id":{},"method":"bad"}\n{"jsonrpc":"2.0","id":7,"method":"good"}\n');
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(frames.trim().split('\n').map(frame => { const value = JSON.parse(frame); return value.error?.code ?? value.result; }), [-32700, -32600, { ok: true }]);
});
test('peer bounds incomplete frames and stalled output queues', async () => {
	const input = new PassThrough(), output = new Writable({ write: () => {} });
	const peer = new AcpPeer(input, output, {}, 128);
	input.write('a'.repeat(129)); assert.equal(peer.isConnected, false);
	const second = new AcpPeer(new PassThrough(), new Writable({ write: () => {} }), {}, 128);
	assert.throws(() => { for (let index = 0; index < 10; index++) { second.notify('event', { text: 'hello' }); } }, /backpressure/);
	assert.equal(second.isConnected, false);
});
