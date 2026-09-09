/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentManager } from './AgentManager';
import { OrchestratorAgent } from './OrchestratorAgent';
import { MetricsTracker } from './MetricsTracker';
import { ProjectMemory } from './ProjectMemory';
import type { AgentEvent } from './agentEvents';
import type { AgentContext, BaseAgent } from './BaseAgent';
import type { ExecutionPlan, SubtaskResult } from './types';
import type { CancellationLike, ChatRequestLike, ChatStreamLike } from '../chatStream';

const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0 };
const result: SubtaskResult = { success: true, summary: 'Done', changes: [], tokenUsage: usage };
const idle: CancellationLike = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function plan(conversationId = 'owner'): ExecutionPlan {
	return { id: conversationId, conversationId, originalRequest: 'Build', scopeDeclaration: { entries: [] }, approved: false, subtasks: [{ id: 'one', assignee: 'anton-code', instruction: 'Build', scopeFiles: [], dependencies: [], status: 'pending', retryCount: 0 }] };
}
function fixture(call: (signal?: AbortSignal) => Promise<void> = async () => { throw new Error('Provider unavailable'); }) {
	const manager = new AgentManager(null as never);
	const orchestrator = new OrchestratorAgent({ handle: 'anton', displayName: 'Anton', description: 'Test', defaultModel: 'sonnet', maxRetries: 1, slashCommands: [] }, null as never, null as never, manager, new MetricsTracker(), new ProjectMemory());
	Object.assign(orchestrator, { appendQuote() {}, gatherGraphContext: async () => '', callLlm: async (_task: string, _model: string, _system: string, _prompt: string, _emit?: (text: string) => void, options?: { signal?: AbortSignal }) => { await call(options?.signal); return { text: '', tokenUsage: usage }; } });
	const events: AgentEvent[] = []; const chunks: string[] = [];
	const stream = { markdown: (text: string) => { chunks.push(text); } } as ChatStreamLike;
	const run = (request: ChatRequestLike = { prompt: 'hello' }, token: CancellationLike = idle, structured = true) => orchestrator.handleChatRequest(request, { history: [] }, stream, token, structured ? event => events.push(event) : undefined);
	return { orchestrator, manager, events, chunks, run };
}

test('conversational and plan exceptions emit one explicit error without successful task completion', async () => {
	for (const command of [undefined, 'plan']) {
		const f = fixture(); await f.run({ prompt: 'hello', command });
		assert.deepEqual({ terminal: f.events.filter(event => event.type === 'error'), states: f.manager.getAllTasks().map(task => task.state), duplicateMarkdown: f.chunks.some(chunk => chunk.includes('**Error:**')) }, { terminal: [{ type: 'error', message: 'Provider unavailable' }], states: ['failed'], duplicateMarkdown: false });
	}
});

test('legacy direct chat receives a single readable error for either orchestration path', async () => {
	for (const command of [undefined, 'plan']) {
		const f = fixture(); await f.run({ prompt: 'hello', command }, idle, false);
		assert.equal(f.chunks.join('').match(/\*\*Error:\*\* Provider unavailable/g)?.length, 1);
	}
});

test('deadline exhaustion fails even when a handler returns normally or provider throws AbortError', async () => {
	for (const reject of [false, true]) {
		const f = fixture(async signal => { await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); if (reject) { throw new DOMException('Aborted', 'AbortError'); } });
		await f.run({ prompt: 'Build feature', command: 'plan', maxRuntimeMs: 5 });
		assert.deepEqual(f.events.filter(event => event.type === 'error'), [{ type: 'error', message: 'Orchestrator runtime budget reached' }]);
	}
});

test('external cancellation remains cancellation with no structured or Markdown error', async () => {
	const controller = new AbortController(); const started = deferred();
	const f = fixture(async signal => { started.resolve(); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); throw new DOMException('Aborted', 'AbortError'); });
	const cancellation: CancellationLike = { get isCancellationRequested() { return controller.signal.aborted; }, onCancellationRequested: listener => { controller.signal.addEventListener('abort', listener); return { dispose: () => controller.signal.removeEventListener('abort', listener) }; } };
	const pending = f.run({ prompt: 'hello' }, cancellation); await started.promise; controller.abort(); await pending;
	assert.deepEqual({ errors: f.events.filter(event => event.type === 'error'), markdownError: f.chunks.join('').includes('**Error:**'), completed: f.manager.getAllTasks().some(task => task.state === 'completed') }, { errors: [], markdownError: false, completed: false });
});

test('approval and rejection cannot mutate another conversation’s plan; native callers remain compatible', async () => {
	for (const command of ['approve', 'reject']) {
		const f = fixture(); const active = plan(); Object.assign(f.orchestrator, { activePlan: active });
		await f.run({ prompt: '', command, conversationId: 'other' });
		assert.deepEqual({ unchanged: f.orchestrator.getActivePlan() === active, approved: active.approved, events: f.events.map(event => event.type) }, { unchanged: true, approved: false, events: ['error'] });
	}
	const f = fixture(); Object.assign(f.orchestrator, { activePlan: plan() }); await f.run({ prompt: '', command: 'reject' });
	assert.deepEqual({ plan: f.orchestrator.getActivePlan(), events: f.events.map(event => event.type) }, { plan: undefined, events: ['plan-rejected'] });
});

test('failed specialist results and blocked-only plans both fail the aggregate turn', async () => {
	for (const blocked of [false, true]) {
		const f = fixture(); const active = plan(); if (blocked) { active.subtasks[0].dependencies = ['one']; }
		Object.assign(f.orchestrator, { activePlan: active });
		f.orchestrator.registerSpecialist({ handle: 'anton-code', execute: async () => ({ ...result, success: false, summary: 'Specialist failed' }) } as unknown as BaseAgent);
		await f.run({ prompt: '', command: 'approve', conversationId: 'owner' });
		assert.deepEqual({ subtask: f.events.some(event => event.type === (blocked ? 'subtask-blocked' : 'subtask-failed')), terminal: f.events.at(-1), states: f.manager.getAllTasks().map(task => task.state) }, { subtask: true, terminal: { type: 'error', message: 'Plan execution failed: 1 of 1 subtasks failed or were blocked.' }, states: ['failed'] });
	}
});

test('an approval keeps its captured context and cannot clear a newer conversation’s plan', async () => {
	const f = fixture(); const active = plan(); active.subtasks[0].scopeFiles = ['file.ts']; active.workspaceContextSnapshot = 'Original context'; active.maxToolCalls = 7;
	const graphStarted = deferred(); const releaseGraph = deferred(); let received: AgentContext | undefined;
	Object.assign(f.orchestrator, { activePlan: active, queryFileGraph: async () => { graphStarted.resolve(); await releaseGraph.promise; return ''; } });
	f.orchestrator.registerSpecialist({ handle: 'anton-code', execute: async (context: AgentContext) => { received = context; return result; } } as BaseAgent);
	const pending = f.run({ prompt: '', command: 'approve', conversationId: 'owner' }); await graphStarted.promise;
	const replacement = plan('new-owner'); Object.assign(f.orchestrator, { activePlan: replacement }); releaseGraph.resolve(); await pending;
	assert.deepEqual({ conversation: received?.conversationId, context: received?.workspaceContextSnapshot, budget: received?.maxToolCalls, replacementSurvived: f.orchestrator.getActivePlan() === replacement }, { conversation: 'owner', context: 'Original context', budget: 7, replacementSurvived: true });
});
