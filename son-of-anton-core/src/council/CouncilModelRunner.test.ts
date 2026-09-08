/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AcpRuntime } from '../acp/AcpRuntime';
import { CouncilModelRunner } from './CouncilModelRunner';

test('Council cancels and releases an ACP participant that leaves its required read-only mode', async t => {
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const runner = new CouncilModelRunner({ streamRequest: async function* () { throw new Error('Native model must not be used'); } }, runtime, () => [{ id: 'fixture', command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')], env: { FIXTURE_MODES: '1' } }], () => true);
	await assert.rejects(runner.run({ conversationId: 'mode-change', member: { id: 'reviewer', label: 'Reviewer', expertise: 'code', stance: 'verify', acpAgent: 'fixture', readOnlyMode: 'review' }, workspace: process.cwd(), prompt: 'leave-review-mode', signal: new AbortController().signal, timeoutMs: 5000, onText: () => assert.fail('Mode violation must not produce a completed answer') }), /cancelled|read-only/);
	await runner.release('mode-change');
	assert.deepEqual([runtime.snapshot().active, runtime.snapshot().processes], [0, 0]);
});
