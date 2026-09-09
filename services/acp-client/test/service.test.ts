/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACPClientImpl } from '../src/client';
import { ACPDispatcher } from '../src/dispatcher';
import { AgentRegistry } from '../src/registry/agentRegistry';
import { createServer } from '../src/server';
import type { SessionEvent } from '../src/types';
import { discoveredAcpModelId, getDiscoveredModel } from '../_shared/acp/dist/llm/DiscoveredModels';

async function fixture(t: TestContext, modelId?: string) {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sota-acp-service-'));
	const config = path.join(root, 'agents.json');
	await writeFile(config, JSON.stringify({ agents: [{ id: 'fixture', name: 'Fixture', transport: 'stdio', command: process.execPath, args: [path.resolve(process.cwd(), '../../son-of-anton-core/test/fixtures/acp-agent.cjs')], modelId, env: modelId ? { FIXTURE_MODEL_IDS: JSON.stringify([modelId]) } : undefined, capabilities: ['analysis'], costTier: 'local' }] }));
	const registry = new AgentRegistry(config); await registry.load();
	const client = new ACPClientImpl(registry, root);
	t.after(async () => { await client.shutdown(); await rm(root, { recursive: true, force: true }); });
	return { client, root };
}
async function httpFixture(t: TestContext) {
	const f = await fixture(t); const server = createServer(f.client, { token: 'fixture-token' });
	server.listen(0, '127.0.0.1'); await once(server, 'listening');
	t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const request = (pathname: string, body?: object) => fetch(url + pathname, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
	return { ...f, url, request, server };
}
test('dispatch subscribes before prompting, captures immediate completion and releases its session', async t => {
	const { client } = await fixture(t);
	const result = await new ACPDispatcher(client).dispatchTask({ taskId: 'one', protocol: 'acp', agentId: 'fixture', task: 'hello' });
	assert.deepEqual([result.status, result.events.map(event => event.type), client.getActiveSessions().length], ['completed', ['message', 'complete'], 0]);
});
test('the packaged runtime negotiates advertised models and registers their transitive catalog dependency', async t => {
	const modelId = 'm'.repeat(512);
	const { client } = await fixture(t, modelId);
	const result = await new ACPDispatcher(client).dispatchTask({ taskId: 'catalog', protocol: 'acp', agentId: 'fixture', task: 'hello' });
	assert.equal(result.status, 'completed');
	assert.equal(getDiscoveredModel(discoveredAcpModelId('fixture', modelId))?.model, modelId);
	assert.equal(client.getActiveSessions().length, 0);
});
test('session continuation reuses the agent and stops fail without hanging dispatch', async t => {
	const { client } = await fixture(t); const session = await client.createSession('fixture', {});
	await client.sendMessage(session.id, 'hello'); await client.sendMessage(session.id, 'again');
	assert.equal(client.runtime.snapshot().reused, 1);
	const result = await new ACPDispatcher(client).dispatchTask({ taskId: 'deadline', protocol: 'acp', agentId: 'fixture', task: 'slow', timeout: 150 });
	assert.equal(result.status, 'failed'); assert.equal(result.events.at(-1)?.type, 'error');
});
test('service rejects workspace escapes and unsupported legacy overrides', async t => {
	const { client } = await fixture(t);
	await assert.rejects(client.createSession('fixture', { cwd: os.tmpdir() }), /inside/);
	await assert.rejects(client.createSession('fixture', { maxTokens: 200 }), /does not support/);
});
test('HTTP auth, readiness, invalid JSON and body limits are enforced', async t => {
	const { url, request } = await httpFixture(t);
	assert.equal((await fetch(url + '/sessions')).status, 401);
	const readiness = await (await request('/ready')).json() as { liveConnectivityChecked: boolean };
	assert.equal(readiness.liveConnectivityChecked, false);
	const invalid = await fetch(url + '/sessions', { method: 'POST', headers: { authorization: 'Bearer fixture-token' }, body: '{' });
	assert.equal(invalid.status, 400);
	const oversized = await request('/sessions', { text: 'x'.repeat(1024 * 1024) }); assert.equal(oversized.status, 413);
});
test('HTTP dispatch streams standard updates through the service facade', async t => {
	const { request } = await httpFixture(t);
	const response = await request('/dispatch', { taskId: 'stream', protocol: 'acp', agentId: 'fixture', task: 'hello', stream: true });
	const body = await response.text();
	assert.equal(response.headers.get('content-type'), 'text/event-stream');
	assert.ok(body.includes('event: message\n')); assert.ok(body.includes('event: result\n')); assert.ok(body.includes('😀'));
});
test('HTTP permissions are explicit, offered-option validated and single use', async t => {
	const { request, client } = await httpFixture(t);
	const session = await client.createSession('fixture', { requestPermissions: true });
	const permission = new Promise<SessionEvent>(resolve => client.onSessionEvent(session.id, event => { if (event.type === 'permission') { resolve(event); } }));
	const running = request(`/sessions/${session.id}/messages`, { message: 'permission', stream: true });
	const event = await permission; const id = (event.data as { id: string }).id;
	assert.equal((await request(`/permissions/${id}`, { optionId: 'invented' })).status, 400);
	assert.equal((await request(`/permissions/${id}`, { optionId: 'yes' })).status, 200);
	assert.ok((await (await running).text()).includes('selected'));
	assert.equal((await request(`/permissions/${id}`, { optionId: 'yes' })).status, 400);
	assert.equal(client.getPendingPermissions().length, 0);
});
test('closing the HTTP event stream cancels the agent prompt', async t => {
	const { client, url } = await httpFixture(t); const controller = new AbortController();
	const response = await fetch(url + '/dispatch', { method: 'POST', headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, body: JSON.stringify({ taskId: 'disconnect', protocol: 'acp', agentId: 'fixture', task: 'slow', stream: true }), signal: controller.signal });
	const ended = new Promise<void>(resolve => client.once('sessionEvent', () => resolve()));
	controller.abort(); await response.body?.cancel().catch(() => {}); await ended;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(client.getActiveSessions().length, 0);
});

test('aborting a partial HTTP body does not crash the service or leave readers attached', async t => {
	const { url, request, server } = await httpFixture(t);
	const received = once(server, 'request');
	const client = http.request(url + '/sessions', { method: 'POST', headers: { authorization: 'Bearer fixture-token', 'content-length': '100' } });
	client.on('error', () => {});
	client.write('{');
	await received; client.destroy();
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal((await request('/health')).status, 200);
});
