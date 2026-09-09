/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import type { MementoStore } from '../host';
import { AcpRuntime, type AcpRecoveryStorageIssue, type AcpTurn } from './AcpRuntime';
import { AcpSessionStore, type AcpSessionRecord } from './AcpSessionStore';
import { object } from './protocol';

const secret = 'private-token-and-transcript-should-never-be-logged';
const agent = { id: 'storage-fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')], env: { PRIVATE_TOKEN: secret } };
const turn = (text = 'hello'): AcpTurn => ({ agent, cwd: process.cwd(), conversationId: 'storage-recovery', text });
const storageError = (code: string) => Object.assign(new Error(`Cannot write /private/${secret}: ${secret}`), { code, path: `/private/${secret}` });
class FaultyMemento implements MementoStore {
	readonly values = new Map<string, unknown>();
	beforeRead?: (key: string) => void;
	beforeWrite?: (key: string, value: unknown) => void | Promise<void>;
	get<T>(key: string, fallback?: T): T { this.beforeRead?.(key); return (this.values.get(key) ?? fallback) as T; }
	async update(key: string, value: unknown): Promise<void> {
		await this.beforeWrite?.(key, value);
		if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); }
	}
}
function capture() {
	let text = '';
	return {
		onUpdate: (update: Parameters<NonNullable<AcpTurn['onUpdate']>>[0]) => { if (object(update.content) && typeof update.content.text === 'string') { text += update.content.text; } },
		get: (): { count: number; text: string; mode: string; model?: string; outcome?: { outcome: string; optionId?: string } } => JSON.parse(text.replace(/ 😀$/, '')),
	};
}

for (const code of ['ENOSPC', 'EROFS', 'EACCES']) {
	test(`${code} before-prompt and final recovery writes do not change successful ACP execution or permissions`, async t => {
		const storage = new FaultyMemento(); storage.beforeWrite = () => { throw storageError(code); };
		const issues: AcpRecoveryStorageIssue[] = [];
		const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(storage), onRecoveryStorageIssue: issue => { issues.push(issue); } });
		t.after(() => runtime.shutdown());
		const denied = capture(), allowed = capture(); let approvals = 0;
		const first = await runtime.run({ ...turn('permission'), onUpdate: denied.onUpdate });
		const second = await runtime.run({ ...turn('permission'), onUpdate: allowed.onUpdate, onPermission: async () => { approvals++; return { outcome: { outcome: 'selected', optionId: 'yes' } }; } });
		assert.deepEqual({ first, second, denied: denied.get().outcome, allowed: allowed.get().outcome, approvals, completed: runtime.snapshot().completed, failed: runtime.snapshot().failed }, {
			first: { stopReason: 'end_turn' }, second: { stopReason: 'end_turn' }, denied: { outcome: 'cancelled' }, allowed: { outcome: 'selected', optionId: 'yes' }, approvals: 1, completed: 2, failed: 0,
		});
		assert.deepEqual(issues, ['before-prompt', 'after-prompt', 'before-prompt', 'after-prompt'].map(phase => ({ phase, code, contextLimited: false })));
	});
}

test('recovery read failures use host context and default diagnostics never include storage errors or agent secrets', async t => {
	const storage = new FaultyMemento();
	storage.beforeRead = key => { if (key.startsWith('sota.acp.session.v1.')) { throw storageError(secret); } };
	storage.beforeWrite = () => { throw storageError(secret); };
	const warnings: unknown[][] = []; t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
	const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(storage) }); t.after(() => runtime.shutdown());
	const result = capture();
	await runtime.run({ ...turn(secret), initialContext: 'Host conversation context', onUpdate: result.onUpdate });
	assert.equal(result.get().text, `Host conversation context\n\n${secret}`);
	assert.deepEqual(warnings, ['read', 'before-prompt', 'after-prompt'].map(phase => ['[acp] Crash recovery storage is unavailable; agent execution can continue.', { phase, code: 'unavailable', contextLimited: false }]));
});

test('throwing and asynchronously rejecting diagnostics cannot block execution or create unhandled rejections', async t => {
	const storage = new FaultyMemento(); storage.beforeWrite = () => { throw storageError('EDQUOT'); };
	let calls = 0;
	const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(storage), onRecoveryStorageIssue: () => {
		if (++calls === 1) { throw new Error(secret); } return Promise.reject(new Error(secret));
	} }); t.after(() => runtime.shutdown());
	assert.deepEqual(await runtime.run(turn()), { stopReason: 'end_turn' });
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(calls, 2);
});

test('storage outages preserve Plan, model selection, tool budgets and external cancellation', async t => {
	const storage = new FaultyMemento(); storage.beforeWrite = () => { throw storageError('EROFS'); };
	const controller = new AbortController(); let cancelBeforePrompt = false; let approvals = 0;
	const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(storage), onRecoveryStorageIssue: issue => { if (cancelBeforePrompt && issue.phase === 'before-prompt') { controller.abort(); } } });
	t.after(() => runtime.shutdown());
	const result = capture();
	await runtime.run({ ...turn('permission'), agent: { ...agent, env: { ...agent.env, FIXTURE_MODES: '1', FIXTURE_MODELS: '1' }, modelId: 'fixture-deep' }, modeId: 'plan', readOnly: true, onUpdate: result.onUpdate, onPermission: async () => { approvals++; return { outcome: { outcome: 'selected', optionId: 'yes' } }; } });
	assert.deepEqual([result.get().mode, result.get().model, result.get().outcome, approvals], ['plan', 'fixture-deep', { outcome: 'cancelled' }, 0]);
	await assert.rejects(runtime.run({ ...turn('permission'), maxToolCalls: 0 }), /tool-call budget/);
	cancelBeforePrompt = true;
	await assert.rejects(runtime.run({ ...turn(), signal: controller.signal }), /cancelled/);
	assert.deepEqual([runtime.snapshot().completed, runtime.snapshot().failed], [1, 2]);
});

test('failed recovery writes retain interruption evidence over an older settled session and later persistence restores resume', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'sota-recovery-outage-')); t.after(() => rm(directory, { recursive: true, force: true }));
	const configured = { ...agent, env: { ...agent.env, FIXTURE_SESSIONS_FILE: path.join(directory, 'sessions.json') } };
	const storage = new FaultyMemento(); const sessionStore = new AcpSessionStore(storage);
	const runtime = new AcpRuntime({ sessionStore, onRecoveryStorageIssue: () => {} }); t.after(() => runtime.shutdown());
	await runtime.run({ ...turn('settled before outage'), agent: configured });
	storage.beforeWrite = () => { throw storageError('ENOSPC'); };
	await assert.rejects(runtime.run({ ...turn('crash'), agent: configured }), /exited|closed/);
	storage.beforeWrite = undefined;
	const result = capture(); const recovered: string[] = [];
	await runtime.run({ ...turn('inspect current state'), agent: configured, onUpdate: result.onUpdate, onRecovery: state => recovered.push(state) });
	assert.deepEqual([result.get().count, recovered], [1, ['interrupted']]);
	assert.match(result.get().text, /User: crash[\s\S]*previous turn was interrupted[\s\S]*inspect current state/);
	await runtime.shutdown();
	const restarted = new AcpRuntime({ sessionStore: new AcpSessionStore(storage) }); t.after(() => restarted.shutdown());
	const resumed = capture();
	await restarted.run({ ...turn('new follow up'), agent: configured, onUpdate: resumed.onUpdate, onRecovery: state => recovered.push(state) });
	assert.deepEqual([resumed.get().count, resumed.get().text, recovered], [2, 'new follow up', ['interrupted', 'resumed']]);
});

test('a failed final write remains successful and a restarted host treats the durable running record as interrupted', async t => {
	const storage = new FaultyMemento(); const issues: AcpRecoveryStorageIssue[] = [];
	storage.beforeWrite = (_key, value) => { if (object(value) && value.state === 'settled') { throw storageError('ENOSPC'); } };
	const runtime = new AcpRuntime({ sessionStore: new AcpSessionStore(storage), onRecoveryStorageIssue: issue => { issues.push(issue); } });
	assert.deepEqual(await runtime.run(turn('completed response')), { stopReason: 'end_turn' }); await runtime.shutdown();
	assert.deepEqual(issues, [{ phase: 'after-prompt', code: 'ENOSPC', contextLimited: false }]);
	storage.beforeWrite = undefined;
	const restarted = new AcpRuntime({ sessionStore: new AcpSessionStore(storage) }); t.after(() => restarted.shutdown());
	const result = capture(); const recovery: string[] = [];
	await restarted.run({ ...turn('follow up'), onUpdate: result.onUpdate, onRecovery: state => recovery.push(state) });
	assert.deepEqual(recovery, ['interrupted']);
	assert.match(result.get().text, /turn interrupted before completion/);
});

test('failure-only fallback bounds full records and never loads evicted settled records as safe sessions', async () => {
	const storage = new FaultyMemento(); const sessionStore = new AcpSessionStore(storage);
	const record = (id: string): AcpSessionRecord => ({ version: 1, conversationId: `anton-code:${id}`, sessionId: id, state: 'settled', transcript: ['old'], updatedAt: 1 });
	await sessionStore.save('first', record('first'));
	const fallback = (sessionStore as unknown as { pendingRecords: Map<string, AcpSessionRecord> }).pendingRecords;
	assert.equal(fallback.size, 0, 'successful persistence does not retain a transcript cache');
	storage.beforeWrite = () => { throw storageError('ENOSPC'); };
	for (let index = 0; index < 33; index++) {
		await assert.rejects(sessionStore.save(index ? `record-${index}` : 'first', { ...record(String(index)), state: 'interrupted', transcript: Array(6).fill('😀'.repeat(64 * 1024)) }), /Cannot write/);
	}
	assert.equal(fallback.size, 32);
	assert.equal(sessionStore.recoveryContextLimited, true);
	assert.equal(sessionStore.get('first')?.state, 'interrupted');
	for (const [key, value] of fallback) { assert.ok(Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024); }
	await assert.rejects(sessionStore.save('oversized', { ...record('oversized'), sessionId: 's'.repeat(512 * 1024) }), /Cannot write/);
	assert.equal(fallback.has('oversized'), false, 'opaque identifiers are skipped rather than truncated');
	storage.beforeWrite = undefined;
	await sessionStore.save('record-32', record('32')); assert.equal(fallback.size, 31);
	await sessionStore.forgetConversation('31'); assert.equal(sessionStore.get('record-31'), undefined);
});
