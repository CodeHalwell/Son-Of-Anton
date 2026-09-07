/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { AcpRuntime, type AcpTurn } from './AcpRuntime';
import { AcpConnection } from './AcpConnection';
import { object, type AcpAgentDefinition } from './protocol';
const definition: AcpAgentDefinition = { id: 'fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')] };
function turn(conversationId: string, text = 'hello'): AcpTurn { return { agent: definition, cwd: process.cwd(), conversationId, text }; }
function capture(): { text: string; update: NonNullable<AcpTurn['onUpdate']> } {
	const result = { text: '', update: (update: Parameters<NonNullable<AcpTurn['onUpdate']>>[0]) => { if (object(update.content) && typeof update.content.text === 'string') { result.text += update.content.text; } } }; return result;
}
function decoded(text: string): { pid: number; count: number; text: string; mode: string; outcome?: { outcome: string; optionId?: string } } { return JSON.parse(text.replace(/ 😀$/, '')); }

test('ACP negotiates standard methods and reuses one process/session for follow-up turns', async t => {
	const runtime = new AcpRuntime({ maxProcesses: 1 }); t.after(() => runtime.shutdown());
	const first = capture(), second = capture();
	await runtime.run({ ...turn('one'), onUpdate: first.update });
	await runtime.run({ ...turn('one', 'follow-up'), onUpdate: second.update });
	assert.deepEqual([decoded(first.text).pid === decoded(second.text).pid, decoded(second.text).count, runtime.snapshot().reused, first.text.endsWith('😀')], [true, 2, 1, true]);
});
test('sessions serialize within a conversation and bound process fan-out across conversations', async t => {
	const runtime = new AcpRuntime({ maxProcesses: 2 }); t.after(() => runtime.shutdown());
	const outputs = Array.from({ length: 8 }, capture);
	await Promise.all(outputs.map((output, index) => runtime.run({ ...turn(index % 2 ? 'one' : 'two'), onUpdate: output.update })));
	assert.deepEqual([new Set(outputs.map(output => decoded(output.text).pid)).size, runtime.snapshot().processes, runtime.snapshot().queued], [2, 2, 0]);
	assert.deepEqual(outputs.filter((_, index) => index % 2).map(output => decoded(output.text).count), [1, 2, 3, 4]);
});
test('idle eviction starts a clean process and restores caller-supplied history', async t => {
	const runtime = new AcpRuntime({ maxProcesses: 1 }); t.after(() => runtime.shutdown());
	await runtime.run(turn('first')); await runtime.run(turn('second'));
	const output = capture();
	await runtime.run({ ...turn('first'), initialContext: 'Saved prior conversation', onUpdate: output.update });
	assert.deepEqual([decoded(output.text).count, decoded(output.text).text], [1, 'Saved prior conversation\n\nhello']);
});
test('bidirectional request ids do not collide and permissions default to cancelled', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const denied = capture(), allowed = capture();
	await runtime.run({ ...turn('deny', 'permission'), onUpdate: denied.update });
	await runtime.run({ ...turn('allow', 'permission'), onUpdate: allowed.update, onPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'yes' } }) });
	assert.deepEqual([decoded(denied.text).outcome, decoded(allowed.text).outcome], [{ outcome: 'cancelled' }, { outcome: 'selected', optionId: 'yes' }]);
});
test('deadline sends session/cancel and releases the process without replay', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'sota-acp-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const cancelFile = path.join(directory, 'cancelled');
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const agent = { ...definition, env: { FIXTURE_CANCEL_FILE: cancelFile } };
	await runtime.run({ ...turn('cancel'), agent });
	await assert.rejects(runtime.run({ ...turn('cancel', 'slow'), agent, timeoutMs: 250 }), /deadline/);
	assert.equal(await readFile(cancelFile, 'utf8'), 'cancelled');
	assert.equal(runtime.snapshot().active, 0);
});
test('queue overflow and queued cancellation do not launch extra agents', async t => {
	const runtime = new AcpRuntime({ maxProcesses: 1, maxQueue: 1 }); t.after(() => runtime.shutdown());
	const first = runtime.run({ ...turn('busy', 'slow'), timeoutMs: 500 }).catch(() => {});
	const controller = new AbortController();
	const queued = runtime.run({ ...turn('queued'), signal: controller.signal });
	await assert.rejects(runtime.run(turn('overflow')), /queue is full/);
	controller.abort(); await assert.rejects(queued, /cancelled/); await first;
	assert.equal(runtime.snapshot().queued, 0);
});
test('crash and oversized frames fail promptly and a new turn can recover', async t => {
	const runtime = new AcpRuntime({ maxProcesses: 1 }); t.after(() => runtime.shutdown());
	await assert.rejects(runtime.run(turn('one', 'crash')), /exited|closed/);
	await assert.rejects(runtime.run(turn('two', 'oversize')), /frame|closed/);
	assert.deepEqual(await runtime.run(turn('recovered')), { stopReason: 'end_turn' });
});
test('unsupported protocol and missing adapter fail without orphaned processes', async () => {
	for (const agent of [{ ...definition, env: { FIXTURE_BAD_VERSION: '1' } }, { id: 'missing', command: '/nonexistent/sota-test-agent' }]) {
		const connection = new AcpConnection(agent, process.cwd());
		try { await assert.rejects(connection.initialize(), /version|ENOENT|exited/); } finally { await connection.stop(); }
		assert.equal(connection.isConnected, false);
	}
});
test('shutdown cancels active and queued requests and is idempotent', async () => {
	const runtime = new AcpRuntime({ maxProcesses: 1 });
	const active = runtime.run(turn('active', 'slow')); const queued = runtime.run(turn('queued'));
	const results = Promise.allSettled([active, queued]);
	await runtime.shutdown(); await runtime.shutdown();
	assert.deepEqual((await results).map(result => result.status), ['rejected', 'rejected']);
	assert.deepEqual([runtime.snapshot().processes, runtime.snapshot().queued], [0, 0]);
});
test('uncooperative agents are killed after cancellation grace instead of keeping the slot forever', async t => {
	const runtime = new AcpRuntime({ maxProcesses: 1 }); t.after(() => runtime.shutdown());
	await runtime.run(turn('uncooperative'));
	const start = Date.now();
	await assert.rejects(runtime.run({ ...turn('uncooperative', 'ignore-cancel'), timeoutMs: 150 }), /deadline/);
	assert.ok(Date.now() - start < 4000);
	assert.deepEqual(await runtime.run(turn('next')), { stopReason: 'end_turn' });
});
test('cancellation resolves a pending permission even when the host callback never answers', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const controller = new AbortController();
	await assert.rejects(runtime.run({ ...turn('permission-cancel', 'permission'), signal: controller.signal, onPermission: async () => { controller.abort(); return new Promise(() => {}); } }), /cancelled/);
	assert.equal(runtime.snapshot().active, 0);
});

test('required ACP modes are negotiated before prompting and cannot reuse a differently configured session', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	await assert.rejects(runtime.run({ ...turn('no-modes'), modeId: 'review' }), /mode/);
	const agent = { ...definition, env: { FIXTURE_MODES: '1' } };
	await assert.rejects(runtime.run({ ...turn('missing-mode'), agent, modeId: 'missing' }), /mode/);
	const first = capture(), second = capture();
	await runtime.run({ ...turn('review'), agent, modeId: 'review', onUpdate: first.update });
	await runtime.run({ ...turn('review'), agent, modeId: 'act', onUpdate: second.update });
	assert.deepEqual([decoded(first.text).mode, decoded(second.text).mode, decoded(first.text).pid !== decoded(second.text).pid], ['review', 'act', true]);
});
test('waiting for a user permission does not consume the agent execution deadline', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	await runtime.run(turn('human-review'));
	const output = capture();
	await runtime.run({ ...turn('human-review', 'permission'), timeoutMs: 250, onUpdate: output.update, onPermission: async () => {
		await new Promise(resolve => setTimeout(resolve, 400)); return { outcome: { outcome: 'selected', optionId: 'yes' } };
	} });
	assert.deepEqual(decoded(output.text).outcome, { outcome: 'selected', optionId: 'yes' });
});
