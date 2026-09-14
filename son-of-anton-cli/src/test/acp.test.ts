/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { AcpPeer } from 'son-of-anton-core/dist/acp/AcpPeer';
import type { AgentStack } from 'son-of-anton-core/dist/agents/AgentStackFactory';
import type { BaseAgent } from 'son-of-anton-core/dist/agents/BaseAgent';
import type { ApprovalGate } from '../approval';
import { AcpHandlers, type HandlerDeps } from '../acp/handlers';

function fixture(overrides: Partial<HandlerDeps> = {}) {
	const work: Array<{ cwd: string; prompt: string; history?: string }> = [];
	const gates: ApprovalGate[] = [];
	const updates: unknown[] = [];
	let disposals = 0;
	const handlers = new AcpHandlers({
		hasCredentials: async () => true,
		sendNotification: (_method, params) => updates.push(params),
		requestPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
		createSession: async (cwd, _servers, gate) => {
			gates.push(gate);
			const agent = {
				displayName: 'Code',
				runAgenticTurn: async (prompt, emit, cancellation, options) => {
					work.push({ cwd, prompt, history: options?.workspaceContextSnapshot });
					if (prompt === 'wait') { await new Promise<void>(resolve => { const sub = cancellation.onCancellationRequested(() => { sub.dispose(); resolve(); }); }); return ''; }
					if (prompt === 'permission') { const decision = await gate({ kind: 'write', detail: 'fixture.ts' }); emit({ type: 'token', token: decision.approved ? 'allowed' : 'denied' }); }
					else { emit({ type: 'token', token: 'reply' }); }
					return 'reply';
				},
			} satisfies Pick<BaseAgent, 'displayName' | 'runAgenticTurn'>;
			return { stack: { specialists: new Map([['anton-code', agent]]) } as unknown as AgentStack, dispose: () => { disposals++; } };
		},
		defaultAgent: 'anton-code', ...overrides,
	});
	return { handlers, work, gates, updates, get disposals() { return disposals; } };
}
async function init(handlers: AcpHandlers) { await handlers.invoke('initialize', { protocolVersion: 1 }); }
async function session(handlers: AcpHandlers, cwd = process.cwd()): Promise<string> { return (await handlers.invoke('session/new', { cwd, mcpServers: [] }) as { sessionId: string }).sessionId; }
const prompt = (handlers: AcpHandlers, sessionId: string, text: string) => handlers.invoke('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

test('ACP server requires initialization and validates session/content parameters', async t => {
	const f = fixture(); t.after(() => f.handlers.dispose());
	await assert.rejects(session(f.handlers), /Initialize/); await init(f.handlers);
	await assert.rejects(f.handlers.invoke('session/new', { cwd: '.', mcpServers: [] }), /absolute/);
	const id = await session(f.handlers);
	await assert.rejects(f.handlers.invoke('session/prompt', { sessionId: id, prompt: 'invalid' }), /array/);
	await assert.rejects(f.handlers.invoke('session/prompt', { sessionId: id, prompt: [{ type: 'image', data: 'invalid' }] }), /Unsupported/);
});
test('two sessions retain independent cwd, history and agent stacks', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'sota-acp-server-')); t.after(() => rm(dir, { recursive: true, force: true }));
	const f = fixture(); t.after(() => f.handlers.dispose()); await init(f.handlers);
	const first = await session(f.handlers), second = await session(f.handlers, dir);
	await Promise.all([prompt(f.handlers, first, 'one'), prompt(f.handlers, second, 'two')]);
	await prompt(f.handlers, first, 'follow-up');
	assert.equal(f.work[0].cwd === f.work[1].cwd, false);
	assert.ok(f.work[2].history?.includes('one')); assert.equal(f.work[2].history?.includes('two'), false);
});
test('new sessions do not cancel other prompts and cancellation is scoped', async t => {
	const f = fixture(); t.after(() => f.handlers.dispose()); await init(f.handlers);
	const first = await session(f.handlers);
	const active = prompt(f.handlers, first, 'wait');
	await assert.rejects(prompt(f.handlers, first, 'duplicate'), /already running/);
	const second = await session(f.handlers);
	assert.deepEqual(await prompt(f.handlers, second, 'hello'), { stopReason: 'end_turn' });
	f.handlers.cancel({ sessionId: first });
	assert.deepEqual(await active, { stopReason: 'cancelled' });
	assert.deepEqual(await prompt(f.handlers, first, 'continue'), { stopReason: 'end_turn' });
});
test('permissions travel over bidirectional ACP and only explicit offered allow approves', async t => {
	const toServer = new PassThrough(), toClient = new PassThrough();
	let server: AcpPeer;
	const f = fixture({ requestPermission: (params, signal) => server.request('session/request_permission', params, { signal }) });
	server = new AcpPeer(toServer, toClient, { request: (method, params) => f.handlers.invoke(method, params) });
	const client = new AcpPeer(toClient, toServer, { request: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }) });
	t.after(() => { f.handlers.dispose(); server.dispose(); client.dispose(); });
	await client.request('initialize', { protocolVersion: 1 });
	const { sessionId } = await client.request<{ sessionId: string }>('session/new', { cwd: process.cwd(), mcpServers: [] });
	await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission' }] });
	assert.ok(JSON.stringify(f.updates).includes('allowed'));
	assert.deepEqual(await f.gates[0]({ kind: 'command', detail: 'after turn' }), { approved: false, reason: 'ACP turn cancelled' });
});
test('session capacity counts concurrent creation and teardown disposes every stack', async () => {
	const f = fixture({ maxSessions: 1 }); await init(f.handlers);
	const results = await Promise.allSettled([session(f.handlers), session(f.handlers)]);
	assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
	f.handlers.dispose(); f.handlers.dispose(); assert.equal(f.disposals, 1);
});
test('resource links and embedded text are preserved instead of silently discarded', async t => {
	const f = fixture(); t.after(() => f.handlers.dispose()); await init(f.handlers);
	const id = await session(f.handlers);
	await f.handlers.invoke('session/prompt', { sessionId: id, prompt: [{ type: 'resource_link', uri: 'file:///workspace/example.ts' }, { type: 'resource', resource: { uri: 'context', text: 'Relevant source text' } }] });
	assert.ok(f.work[0].prompt.includes('file:///workspace/example.ts')); assert.ok(f.work[0].prompt.includes('Relevant source text'));
});

test('read-only ACP sessions advertise only review mode and never invoke the specialist stack', async t => {
	const requests: string[] = [];
	const f = fixture({ createSession: async () => ({ review: async (text, _signal, onText) => { requests.push(text); onText('Evidence reviewed'); }, dispose() {} }) });
	t.after(() => f.handlers.dispose()); await init(f.handlers);
	const result = await f.handlers.invoke('session/new', { cwd: process.cwd(), mcpServers: [] }) as { sessionId: string; modes: { availableModes: Array<{ id: string }> } };
	assert.deepEqual(result.modes.availableModes.map(mode => mode.id), ['council-review']);
	await assert.rejects(f.handlers.invoke('session/set_mode', { sessionId: result.sessionId, modeId: 'anton-code' }), /Unknown/);
	await f.handlers.invoke('session/set_mode', { sessionId: result.sessionId, modeId: 'council-review' });
	assert.deepEqual(await prompt(f.handlers, result.sessionId, 'Review supplied text'), { stopReason: 'end_turn' });
	assert.deepEqual(requests, ['Review supplied text']); assert.equal(f.work.length, 0); assert.equal(f.gates.length, 0);
});
