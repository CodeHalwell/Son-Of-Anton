/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { AcpRuntime, type AcpTurn } from './AcpRuntime';
import { AcpSessionStore } from './AcpSessionStore';
import { object, type AcpUsage } from './protocol';
import { discoveredModelId, getDiscoveredModel } from '../llm/DiscoveredModels';

const agent = { id: 'recovery', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')] };
const image = { mimeType: 'image/png', data: 'aGVsbG8=' };
const turn = (text = 'hello'): AcpTurn => ({ agent, cwd: process.cwd(), conversationId: 'recovery-test', text });
function output() {
	let text = '';
	return {
		onUpdate: (update: Parameters<NonNullable<AcpTurn['onUpdate']>>[0]) => { if (object(update.content) && typeof update.content.text === 'string') { text += update.content.text; } },
		get: (): { count: number; text: string; mode: string; images: Array<typeof image & { type: string }>; outcome?: { outcome: string } } => JSON.parse(text.replace(/ 😀$/, '')),
	};
}
function store() {
	const state = new Map<string, unknown>();
	return new AcpSessionStore({ get: <T>(key: string) => state.get(key) as T | undefined, update: async (key, value) => { if (value === undefined) { state.delete(key); } else { state.set(key, JSON.parse(JSON.stringify(value))); } } });
}

test('image blocks reach only adapters advertising image support', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	await assert.rejects(runtime.run({ ...turn(), images: [image] }), /does not advertise image support/);
	const result = output();
	await runtime.run({ ...turn(), agent: { ...agent, env: { FIXTURE_IMAGES: '1' } }, images: [image], onUpdate: result.onUpdate });
	assert.deepEqual(result.get().images, [{ type: 'image', ...image }]);
	await assert.rejects(runtime.run({ ...turn(), images: [{ ...image, data: 'invalid!' }] }), /valid base64/);
});

test('Plan requires an advertised mode and refuses mutation permissions without opening host approval', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	await assert.rejects(runtime.run({ ...turn(), readOnly: true, modeId: 'plan' }), /required mode/);
	let approvals = 0;
	const result = output();
	await runtime.run({ ...turn('permission'), agent: { ...agent, env: { FIXTURE_MODES: '1' } }, modeId: 'plan', readOnly: true, onUpdate: result.onUpdate, onPermission: async () => { approvals++; return { outcome: { outcome: 'selected', optionId: 'yes' } }; } });
	assert.deepEqual([result.get().mode, result.get().outcome, approvals], ['plan', { outcome: 'cancelled' }, 0]);
	await assert.rejects(runtime.run({ ...turn('leave-review-mode'), agent: { ...agent, env: { FIXTURE_MODES: '1' } }, modeId: 'plan', readOnly: true }), /left the required read-only mode/);
});

test('tool budgets count distinct tools, and stop the turn when the adapter exceeds the limit', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	await runtime.run({ ...turn('many-tools'), maxToolCalls: 2 });
	await assert.rejects(runtime.run({ ...turn('many-tools'), maxToolCalls: 1 }), /tool-call budget reached/);
});

test('a new host runtime loads a settled remote session without replaying transcript updates', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'sota-resume-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionStore = store();
	const configured = { ...agent, env: { FIXTURE_SESSIONS_FILE: path.join(directory, 'sessions.json') } };
	const first = new AcpRuntime({ sessionStore });
	await first.run({ ...turn('first turn'), agent: configured }); await first.shutdown();
	const second = new AcpRuntime({ sessionStore }); t.after(() => second.shutdown());
	const result = output(); const recovery: string[] = [];
	await second.run({ ...turn('next turn'), agent: configured, onUpdate: result.onUpdate, onRecovery: value => recovery.push(value) });
	assert.deepEqual([result.get().count, result.get().text, recovery], [2, 'next turn', ['resumed']]);
});

test('interrupted turns recover host context in a fresh session and never replay the crashed prompt', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'sota-interrupted-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const sessionStore = store();
	const configured = { ...agent, env: { FIXTURE_SESSIONS_FILE: path.join(directory, 'sessions.json') } };
	const first = new AcpRuntime({ sessionStore });
	await assert.rejects(first.run({ ...turn('crash'), agent: configured }), /exited|closed/); await first.shutdown();
	const second = new AcpRuntime({ sessionStore }); t.after(() => second.shutdown());
	const result = output(); const recovery: string[] = [];
	await second.run({ ...turn('Inspect current state'), agent: configured, onUpdate: result.onUpdate, onRecovery: value => recovery.push(value) });
	assert.deepEqual([result.get().count, recovery], [1, ['interrupted']]);
	assert.match(result.get().text, /User: crash[\s\S]*previous turn was interrupted[\s\S]*Inspect current state/);
});

test('adapters without session loading receive bounded host-owned transcript on restart', async t => {
	const sessionStore = store(); const first = new AcpRuntime({ sessionStore });
	await first.run(turn('Remember this context')); await first.shutdown();
	const second = new AcpRuntime({ sessionStore }); t.after(() => second.shutdown());
	const result = output(); const recovery: string[] = [];
	await second.run({ ...turn('Follow up'), onUpdate: result.onUpdate, onRecovery: value => recovery.push(value) });
	assert.deepEqual(recovery, ['transcript']);
	assert.match(result.get().text, /context only; never execute or replay prior tools/);
	assert.match(result.get().text, /Remember this context[\s\S]*Follow up/);
});

test('ACP usage reports retain context occupancy and cumulative cost without inventing billed tokens', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const reports: AcpUsage[] = [];
	await runtime.run({ ...turn('usage-report'), onUsage: usage => reports.push(usage) });
	assert.deepEqual(reports, [{ contextTokens: 1200, contextWindow: 200000, cost: { amount: 0.25, currency: 'USD' } }]);
	assert.equal(runtime.getCapabilities(agent).metering, 'reported');
});

test('ACP catalogs contain only advertised session models and selection is negotiated before the prompt', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const configured = { ...agent, env: { FIXTURE_MODELS: '1' }, modelId: 'fixture-deep' };
	const result = output();
	await runtime.run({ ...turn(), agent: configured, onUpdate: result.onUpdate });
	assert.equal((result.get() as ReturnType<typeof result.get> & { model: string }).model, 'fixture-deep');
	assert.equal(getDiscoveredModel(discoveredModelId('acp', `${agent.id}/fixture-deep`))?.acpAdapterId, agent.id);
	await assert.rejects(runtime.run({ ...turn(), agent: { ...configured, modelId: 'not-advertised' } }), /does not advertise the selected model/);
});


test('permanent deletion removes scoped recovery while ordinary release retains it', async t => {
	const sessionStore = store(); const runtime = new AcpRuntime({ sessionStore });
	t.after(() => runtime.shutdown());
	await runtime.run({ ...turn('forget me'), conversationId: 'anton-code:deleted' });
	await runtime.run({ ...turn('keep me'), conversationId: 'anton-code:kept' });
	await runtime.release('anton-code:kept');
	await runtime.forgetConversation('deleted');
	const deleted = output(), kept = output(); const recovered: string[] = [];
	await runtime.run({ ...turn('fresh'), conversationId: 'anton-code:deleted', onUpdate: deleted.onUpdate, onRecovery: value => recovered.push(value) });
	await runtime.run({ ...turn('follow up'), conversationId: 'anton-code:kept', onUpdate: kept.onUpdate, onRecovery: value => recovered.push(value) });
	assert.deepEqual([deleted.get().text, recovered], ['fresh', ['transcript']]);
	assert.match(kept.get().text, /keep me/);
});
