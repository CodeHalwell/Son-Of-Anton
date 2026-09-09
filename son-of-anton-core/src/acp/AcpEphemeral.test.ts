/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpRuntime, type AcpTurn } from './AcpRuntime';
import { AcpSessionStore } from './AcpSessionStore';
import { object } from './protocol';
import { createAgentStack } from '../agents/AgentStackFactory';
import { AgentManager } from '../agents/AgentManager';
import { CouncilModelRunner } from '../council/CouncilModelRunner';
import { CouncilService } from '../council/CouncilService';
import { CouncilStore } from '../council/CouncilStore';
import { defaultCouncilGroup } from '../council/prompts';
import type { CouncilMember, CouncilTurn } from '../council/types';
import type { MementoStore } from '../host';
import { LlmClient } from '../llm/LlmClient';
import { McpClient } from '../mcp/McpClient';

const agent = { id: 'ephemeral-fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')], env: { FIXTURE_MODES: '1' } };
const member: CouncilMember = { id: 'reviewer', label: 'Reviewer', expertise: 'code', stance: 'verify', acpAgent: agent.id, readOnlyMode: 'review' };
const noNative = { streamRequest: async function* () { throw new Error('Native model must not be used'); } };
const councilTurn = (prompt: string, conversationId = 'council:report:stage'): CouncilTurn => ({ conversationId, member, workspace: process.cwd(), prompt, signal: new AbortController().signal, timeoutMs: 5000, onText: () => {} });

function memory() {
	const state = new Map<string, unknown>();
	const memento: MementoStore = {
		get: <T>(key: string, fallback?: T) => (state.get(key) ?? fallback) as T,
		update: async (key, value) => { if (value === undefined) { state.delete(key); } else { state.set(key, structuredClone(value)); } },
	};
	return { state, memento };
}
function output() {
	let text = '';
	return {
		onUpdate: (update: Parameters<NonNullable<AcpTurn['onUpdate']>>[0]) => { if (object(update.content) && typeof update.content.text === 'string') { text += update.content.text; } },
		get: (): { count: number; text: string; pid: number } => JSON.parse(text.replace(/ 😀$/, '')),
	};
}

test('ephemeral ACP sessions neither reuse nor replace ordinary recovery, whose existing key remains stable', async t => {
	const { state, memento } = memory();
	const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(memento) }); t.after(() => runtime.shutdown());
	const turn: AcpTurn = { agent, cwd: process.cwd(), conversationId: 'ordinary-chat', text: 'Remember ordinary context' };
	const ordinary = output(); await runtime.run({ ...turn, onUpdate: ordinary.onUpdate });
	const fingerprint = createHash('sha256').update(JSON.stringify([agent, [], undefined, undefined])).digest('hex');
	const legacyKey = JSON.stringify([turn.conversationId, turn.cwd, fingerprint]);
	assert.ok(state.has(`sota.acp.session.v1.${createHash('sha256').update(legacyKey).digest('hex')}`));
	const retained = structuredClone([...state.entries()]);
	const ephemeral = output();
	await runtime.run({ ...turn, text: 'One-shot question', initialContext: 'One-shot context', persistRecovery: false, onUpdate: ephemeral.onUpdate, onRecovery: () => assert.fail('Ephemeral runs must not recover host context') });
	assert.equal(ephemeral.get().count, 1);
	assert.notEqual(ephemeral.get().pid, ordinary.get().pid);
	assert.equal(ephemeral.get().text, 'One-shot context\n\nOne-shot question');
	assert.deepEqual([...state.entries()], retained);
	await runtime.release(turn.conversationId);
	const followup = output(); const recovered: string[] = [];
	await runtime.run({ ...turn, persistRecovery: true, text: 'Continue ordinary chat', onUpdate: followup.onUpdate, onRecovery: state => recovered.push(state) });
	assert.deepEqual(recovered, ['transcript']);
	assert.match(followup.get().text, /Remember ordinary context[\s\S]*Continue ordinary chat/);
	assert.doesNotMatch(followup.get().text, /One-shot/);
});

test('Council never touches failing or nonsettling recovery storage, including session release', { timeout: 10_000 }, async t => {
	for (const failure of ['ENOSPC', 'EROFS', 'pending']) {
		let reads = 0, writes = 0, diagnostics = 0;
		const memento: MementoStore = {
			get: () => { reads++; throw Object.assign(new Error('Recovery storage unavailable'), { code: failure }); },
			update: () => { writes++; return failure === 'pending' ? new Promise<void>(() => {}) : Promise.reject(Object.assign(new Error('Recovery storage unavailable'), { code: failure })); },
		};
		const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(memento), onRecoveryStorageIssue: () => { diagnostics++; } }); t.after(() => runtime.shutdown());
		const runner = new CouncilModelRunner(noNative, runtime, () => [agent], () => true);
		let text = '';
		const turn = { ...councilTurn('permission', `council:${failure}:stage`), onText: (chunk: string) => { text += chunk; } };
		await runner.run(turn);
		await runner.release(turn.conversationId);
		assert.equal(JSON.parse(text.replace(/ 😀$/, '')).outcome.outcome, 'cancelled', 'Council must still deny mutable tool permissions');
		assert.deepEqual({ reads, writes, diagnostics, processes: runtime.snapshot().processes, active: runtime.snapshot().active }, { reads: 0, writes: 0, diagnostics: 0, processes: 0, active: 0 });
	}
});

test('cancelled, timed-out and mode-violating Council stages release processes without recovery records', { timeout: 25_000 }, async t => {
	const { state, memento } = memory();
	const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(memento) }); t.after(() => runtime.shutdown());
	const runner = new CouncilModelRunner(noNative, runtime, () => [agent], () => true);
	for (const reason of ['cancel', 'deadline', 'mode']) {
		const turn = councilTurn('hello', `council:lifecycle:${reason}`);
		await runner.run(turn);
		const controller = new AbortController();
		const timer = reason === 'cancel' ? setTimeout(() => controller.abort(), 30) : undefined;
		const started = Date.now();
		try {
			await assert.rejects(runner.run({ ...turn, prompt: reason === 'mode' ? 'leave-review-mode' : 'ignore-cancel', signal: controller.signal, timeoutMs: reason === 'deadline' ? 50 : 5000 }), reason === 'deadline' ? /deadline/ : /cancelled|read-only/);
		} finally { clearTimeout(timer); await runner.release(turn.conversationId); }
		assert.ok(Date.now() - started < 8000, 'Teardown must stay within the cancellation grace and platform process-stop bounds');
		assert.deepEqual([state.size, runtime.snapshot().active, runtime.snapshot().processes, runtime.snapshot().queued], [0, 0, 0, 0]);
	}
});

test('the canonical shared runtime keeps Council reports without accumulating per-stage Memento records', { timeout: 15_000 }, async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sota-council-recovery-'));
	const { state, memento } = memory();
	const settings: Record<string, unknown> = { 'sota.agents.anton-code.acpAgent': agent.id, 'sota.acp.agents': [agent] };
	const config = { get: <T>(key: string, fallback?: T) => (settings[key] ?? fallback) as T };
	const llm = new LlmClient({ get: async () => { throw new Error('Native model must not be used'); }, store: async () => {}, delete: async () => {} }, config);
	const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => root, onSettingChange: () => ({ dispose() {} }) });
	const stack = createAgentStack({ llmClient: llm, mcpClient: mcp, agentManager: new AgentManager(llm), globalState: memento, workspaceRoot: root, configStore: config, canUseAcp: () => true, persistMetrics: false });
	const runtime = stack.acpRuntime!;
	const runner = new CouncilModelRunner(llm, runtime, () => [agent], () => true);
	const store = new CouncilStore(path.join(root, 'reports')); const service = new CouncilService(store, runner);
	t.after(async () => { await service.dispose(); await stack.dispose(); mcp.dispose(); await rm(root, { recursive: true, force: true }); });
	const code = stack.specialists.get('anton-code')!;
	const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
	await code.runAgenticTurn('Remember ordinary specialist context', () => {}, cancellation, { conversationId: 'ordinary' });
	await runtime.release('anton-code:ordinary');
	const recoveryEntries = () => [...state.entries()].filter(([key]) => key.startsWith('sota.acp.session.'));
	const retained = structuredClone(recoveryEntries());
	assert.deepEqual(Object.values(state.get('sota.acp.session.index.v1') as Record<string, string>), ['anton-code:ordinary']);
	const group = defaultCouncilGroup();
	const useAcp = (value: CouncilMember): CouncilMember => ({ ...value, model: undefined, acpAgent: agent.id, readOnlyMode: 'review' });
	group.members = group.members.map(useAcp); group.chair = useAcp(group.chair); group.reviewer = group.reviewer && useAcp(group.reviewer);
	for (let index = 0; index < 2; index++) {
		const id = await service.start(`Review ${index}`, group, { workspace: root, head: 'a'.repeat(40), base: 'b'.repeat(40), digest: 'c'.repeat(64), capturedAt: 1, patch: '', files: [], limitations: [] });
		const report = await service.wait(id);
		// The fixture returns an unstructured answer. Failed quorum must retain
		// those real stage responses in Council history just as successful runs do.
		assert.equal(report.status, 'quorum-failed');
		assert.equal(report.stages.length, group.members.length);
		assert.ok(report.stages.every(stage => stage.status === 'failed' && stage.text.endsWith('😀')));
		assert.deepEqual(await store.load(id), JSON.parse(JSON.stringify(report)));
		assert.deepEqual(recoveryEntries(), retained);
		assert.deepEqual([runtime.snapshot().active, runtime.snapshot().processes], [0, 0]);
	}
	assert.equal((await store.list()).length, 2);
	const resumed = await code.runAgenticTurn('Follow up', () => {}, cancellation, { conversationId: 'ordinary' });
	assert.match(JSON.parse(resumed.replace(/ 😀$/, '')).text, /Remember ordinary specialist context[\s\S]*Follow up/);
	assert.deepEqual(Object.values(state.get('sota.acp.session.index.v1') as Record<string, string>), ['anton-code:ordinary']);
	const afterFollowup = structuredClone(recoveryEntries());
	for (let index = 0; index < 2; index++) {
		const anonymous = await code.runAgenticTurn(`Anonymous ${index}`, () => {}, cancellation);
		assert.equal(JSON.parse(anonymous.replace(/ 😀$/, '')).count, 1);
		assert.deepEqual(recoveryEntries(), afterFollowup, 'A locally generated anonymous ID cannot be recovered by a later caller');
	}
});
