/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { diagnoseAcp } from './AcpDiagnostics';
const agent = { id: 'diagnostic', command: process.execPath, args: [resolve(__dirname, '../../test/fixtures/acp-agent.cjs')] };
test('diagnostics distinguish session readiness from a live text response', async () => {
	const session = await diagnoseAcp(agent, process.cwd()); const live = await diagnoseAcp(agent, process.cwd(), { live: true });
	assert.deepEqual([session.status, session.textChunks, live.status, live.textChunks > 0], ['session-ready', 0, 'prompt-completed', true]);
});
test('diagnostics report missing executables and cancellation without launching a prompt', async () => {
	const missing = await diagnoseAcp({ id: 'missing', command: '/nonexistent/sota-acp-fixture' }, process.cwd());
	const cancelled = await diagnoseAcp(agent, process.cwd(), { signal: AbortSignal.abort() });
	assert.deepEqual([missing.status, cancelled.status, cancelled.textChunks], ['unavailable', 'cancelled', 0]);
});
