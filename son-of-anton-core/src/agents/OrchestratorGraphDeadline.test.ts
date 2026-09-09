/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { AgentManager } from './AgentManager';
import { OrchestratorAgent } from './OrchestratorAgent';
import { MetricsTracker } from './MetricsTracker';
import { ProjectMemory } from './ProjectMemory';
import type { AgentContext, BaseAgent } from './BaseAgent';
import type { AgentEvent } from './agentEvents';
import type { ExecutionPlan, SubtaskResult } from './types';
import type { CancellationLike, ChatStreamLike } from '../chatStream';
import { McpClient } from '../mcp/McpClient';

const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0 };
const result: SubtaskResult = { success: true, summary: 'Completed first task', changes: [], tokenUsage: usage };
const idle: CancellationLike = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
function deferred<T>() {
	let resolve!: (value: T) => void; let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
	return { promise, resolve, reject };
}
type Reply = { content: string; isError: boolean };
function fixture(query: (tool: string, inputs: Record<string, unknown>, signal?: AbortSignal) => Promise<Reply>, startup?: () => Promise<void>) {
	const client = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => undefined, onSettingChange: () => ({ dispose() {} }) });
	// Exercise the real McpClient await boundaries with a transport that ignores abort.
	Object.assign(client, {
		initialise: startup ?? (async () => {}),
		connections: new Map([['code-graph', { connection: { state: 'ready', callTool: query, dispose() {} } }]]),
	});
	const manager = new AgentManager(null as never);
	const orchestrator = new OrchestratorAgent({ handle: 'anton', displayName: 'Anton', description: 'Test', defaultModel: 'sonnet', maxRetries: 1, slashCommands: [] }, null as never, client, manager, new MetricsTracker(), new ProjectMemory());
	const prompts: string[] = []; const contexts: AgentContext[] = []; const events: AgentEvent[] = []; const chunks: string[] = [];
	Object.assign(orchestrator, {
		appendQuote() {},
		callLlm: async (_task: string, _model: string, _system: string, prompt: string) => {
			prompts.push(prompt);
			return { text: '```json\n{"subtasks":[{"assignee":"anton-code","instruction":"Build","scopeFiles":[],"dependencies":[]}]}\n```', tokenUsage: usage };
		},
	});
	orchestrator.registerSpecialist({ handle: 'anton-code', execute: async (context: AgentContext) => { contexts.push(context); return result; } } as BaseAgent);
	const plan: ExecutionPlan = { id: 'plan', conversationId: 'owner', originalRequest: 'Build', scopeDeclaration: { entries: [] }, approved: false, subtasks: [{ id: 'one', assignee: 'anton-code', instruction: 'Build', scopeFiles: ['first.ts', 'wait.ts', 'never.ts'], dependencies: [], status: 'pending', retryCount: 0 }] };
	const run = (command: 'plan' | 'approve', token = idle) => {
		if (command === 'approve') { Object.assign(orchestrator, { activePlan: plan }); }
		return orchestrator.handleChatRequest({ prompt: 'Build a feature', command, conversationId: 'owner', maxRuntimeMs: 1000 }, { history: [] }, { markdown: text => chunks.push(text) } as ChatStreamLike, token, event => events.push(event));
	};
	return { client, manager, plan, events, chunks, contexts, prompts, run };
}

for (const command of ['plan', 'approve'] as const) {
	for (const stop of ['deadline', 'cancel'] as const) {
		test(`${command} ${stop} bounds an uncooperative graph tool and forbids later execution`, { timeout: 3000 }, async t => {
			t.mock.timers.enable({ apis: ['setTimeout'] });
			const entered = deferred<void>(); const reply = deferred<Reply>(); const calls: string[] = []; let signal: AbortSignal | undefined;
			const f = fixture(async (tool, inputs, nextSignal) => {
				calls.push(String(inputs.filePath ?? tool)); signal = nextSignal;
				if (inputs.filePath === 'first.ts') { return { content: 'Partial graph data', isError: false }; }
				entered.resolve(); return reply.promise;
			}); t.after(() => f.client.dispose());
			const controller = new AbortController();
			const token: CancellationLike = { get isCancellationRequested() { return controller.signal.aborted; }, onCancellationRequested: listener => { controller.signal.addEventListener('abort', listener); return { dispose: () => controller.signal.removeEventListener('abort', listener) }; } };
			const running = f.run(command, token); await entered.promise;
			if (stop === 'deadline') { t.mock.timers.tick(1000); } else { controller.abort(); }
			await running;
			assert.deepEqual({ errors: f.events.filter(event => event.type === 'error'), llm: f.prompts.length, specialists: f.contexts.length, calls, aborted: signal?.aborted, listeners: getEventListeners(signal!, 'abort').length }, {
				errors: stop === 'deadline' ? [{ type: 'error', message: 'Orchestrator runtime budget reached' }] : [], llm: 0, specialists: 0, calls: command === 'plan' ? ['semantic_search'] : ['first.ts', 'wait.ts'], aborted: true, listeners: 0,
			});
			const snapshot = JSON.stringify(f.events);
			reply.reject(new Error('Late graph failure')); await new Promise<void>(resolve => setImmediate(resolve));
			assert.deepEqual([JSON.stringify(f.events), f.contexts.length, f.prompts.length], [snapshot, 0, 0]);
		});
	}
}

for (const command of ['plan', 'approve'] as const) {
	test(`${command} deadline stops waiting for shared startup without cancelling another caller`, { timeout: 3000 }, async t => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const startup = deferred<void>(); const entered = deferred<void>(); let starts = 0; const calls: string[] = [];
		const f = fixture(async tool => { calls.push(tool); return { content: 'Graph connected', isError: false }; }, () => { starts++; entered.resolve(); return startup.promise; });
		t.after(() => f.client.dispose());
		const running = f.run(command); await entered.promise;
		const other = f.client.callTool({ server: 'code-graph', tool: 'other-conversation', inputs: {} });
		t.mock.timers.tick(1000); await running;
		assert.deepEqual([f.events.filter(event => event.type === 'error'), starts, calls, f.contexts.length, f.prompts.length], [[{ type: 'error', message: 'Orchestrator runtime budget reached' }], 1, [], 0, 0]);
		startup.resolve(); assert.equal((await other).content, 'Graph connected');
		assert.deepEqual([calls, f.contexts.length, f.prompts.length], [['other-conversation'], 0, 0]);
	});
}

test('late startup rejection after user cancellation is consumed without changing the terminal outcome', { timeout: 3000 }, async t => {
	const startup = deferred<void>(); const entered = deferred<void>();
	const f = fixture(async () => { throw new Error('Must not dispatch'); }, () => { entered.resolve(); return startup.promise; });
	t.after(() => f.client.dispose());
	const controller = new AbortController();
	const token: CancellationLike = { get isCancellationRequested() { return controller.signal.aborted; }, onCancellationRequested: listener => { controller.signal.addEventListener('abort', listener); return { dispose: () => controller.signal.removeEventListener('abort', listener) }; } };
	const running = f.run('plan', token); await entered.promise; controller.abort(); await running;
	startup.reject(new Error('Late connection failure')); await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual([f.events, f.prompts, f.contexts], [[], [], []]);
});

test('available graph data and ordinary soft failures still reach planning and specialist context', async t => {
	const signals: AbortSignal[] = [];
	const f = fixture(async (_tool, inputs, signal) => {
		signals.push(signal!);
		return inputs.filePath === 'wait.ts' ? { content: 'Private server diagnostic', isError: true } : { content: 'Available graph data', isError: false };
	}); t.after(() => f.client.dispose());
	await f.run('plan'); await f.run('approve');
	assert.match(f.prompts[0], /Available graph data/);
	assert.match(f.contexts[0].graphContext, /### first.ts\nAvailable graph data/);
	assert.doesNotMatch(f.contexts[0].graphContext, /Private server diagnostic/);
	assert.deepEqual([f.events.filter(event => event.type === 'error'), signals.every(signal => !signal.aborted && getEventListeners(signal, 'abort').length === 0)], [[], true]);
});

test('a completed parallel specialist result survives deadline cancellation of another subtask’s graph read', { timeout: 3000 }, async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const entered = deferred<void>(); const reply = deferred<Reply>();
	const f = fixture(async () => { entered.resolve(); return reply.promise; }); t.after(() => f.client.dispose());
	f.plan.subtasks = [
		{ ...f.plan.subtasks[0], id: 'complete', instruction: 'Already completed', scopeFiles: [] },
		{ ...f.plan.subtasks[0], id: 'waiting', instruction: 'Waiting for graph', scopeFiles: ['wait.ts'] },
	];
	const running = f.run('approve'); await entered.promise; await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(f.events.some(event => event.type === 'subtask-completed' && event.subtaskId === 'complete'), true);
	t.mock.timers.tick(1000); await running; reply.resolve({ content: 'Too late', isError: false });
	assert.deepEqual({ completed: f.events.filter(event => event.type === 'subtask-completed').map(event => event.subtaskId), specialists: f.contexts.length, terminal: f.events.at(-1) }, { completed: ['complete'], specialists: 1, terminal: { type: 'error', message: 'Orchestrator runtime budget reached' } });
});
