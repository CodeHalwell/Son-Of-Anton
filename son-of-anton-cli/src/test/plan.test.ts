/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OrchestratorAgent } from 'son-of-anton-core/dist/agents/OrchestratorAgent';
import type { StreamEvent } from '../render/renderer';
import { runPlan } from '../commands/plan';
import { SOTA_EXIT_CODES } from '../headless';

const builder = require('../agentStackBuilder') as typeof import('../agentStackBuilder');
const auth = require('../auth/bootstrap') as typeof import('../auth/bootstrap');
const cliHost = require('../cliHost') as typeof import('../cliHost');
const headless = require('../headless') as typeof import('../headless');
const rendering = require('../render/renderer') as typeof import('../render/renderer');

for (const scenario of ['success', 'reported-failure', 'reported-then-thrown', 'cancelled'] as const) {
	test(`plan command reports ${scenario} without a false completion`, async t => {
		const events: StreamEvent[] = []; let disposed = 0;
		const previousExitCode = process.exitCode, listeners = process.listenerCount('SIGINT');
		t.after(() => { process.exitCode = previousExitCode; });
		process.exitCode = undefined;
		t.mock.method(cliHost, 'buildCliHost', () => ({}));
		t.mock.method(auth, 'bootstrapCredentials', async () => ({ ok: true }));
		t.mock.method(headless, 'readPipedStdin', async () => '');
		t.mock.method(rendering, 'makeRenderer', () => ({ emit: (event: StreamEvent) => events.push(event), end() {} }));
		const handleChatRequest: OrchestratorAgent['handleChatRequest'] = async (request, _context, _stream, _token, emit) => {
			assert.equal(request.command, 'plan');
			if (scenario === 'cancelled') { process.emit('SIGINT'); return; }
			if (scenario !== 'success') { emit?.({ type: 'error', message: 'Fixture planning failure' }); }
			if (scenario === 'reported-then-thrown') { throw new Error('Fixture planning failure'); }
		};
		t.mock.method(builder, 'buildCliAgentStack', () => ({ stack: { orchestrator: { handleChatRequest } }, dispose: () => { disposed++; } }));
		await runPlan('Plan a fixture change', { output: 'json' });
		assert.deepEqual(events, scenario === 'success' ? [{ type: 'done' }] : scenario === 'cancelled' ? [] : [{ type: 'error', message: 'Fixture planning failure' }]);
		assert.equal(process.exitCode ?? 0, scenario === 'success' ? SOTA_EXIT_CODES.OK : scenario === 'cancelled' ? SOTA_EXIT_CODES.CANCELLED : SOTA_EXIT_CODES.HARD_FAIL);
		assert.equal(disposed, 1); assert.equal(process.listenerCount('SIGINT'), listeners);
	});
}
