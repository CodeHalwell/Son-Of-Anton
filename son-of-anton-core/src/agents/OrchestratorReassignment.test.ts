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
import { planEditRevision } from './planEditing';
import type { AgentEvent } from './agentEvents';
import type { AgentContext, BaseAgent } from './BaseAgent';
import type { ExecutionPlan } from './types';
import type { ChatStreamLike } from '../chatStream';

function fixture() {
	const orchestrator = new OrchestratorAgent({ handle: 'anton', displayName: 'Anton', description: 'Test', defaultModel: 'sonnet', maxRetries: 1, slashCommands: [] }, null as never, null as never, new AgentManager(null as never), new MetricsTracker(), new ProjectMemory());
	const plan: ExecutionPlan = { id: 'plan-one', conversationId: 'owner', originalRequest: 'Build', scopeDeclaration: { entries: [{ agent: 'anton-code', files: ['file.ts'], accessType: 'read' }] }, approved: false, subtasks: [{ id: 'one', assignee: 'anton-code', instruction: 'Build', scopeFiles: ['file.ts'], dependencies: [], status: 'pending', retryCount: 0 }] };
	const called: string[] = []; const contexts: AgentContext[] = [];
	for (const handle of ['anton-code', 'anton-test'] as const) { orchestrator.registerSpecialist({ handle, execute: async (context: AgentContext) => { called.push(handle); contexts.push(context); return { success: true, summary: 'Done', changes: [], tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0 } }; } } as unknown as BaseAgent); }
	Object.assign(orchestrator, { activePlan: plan, appendQuote() {}, queryFileGraph: async () => '' });
	const revision = () => planEditRevision(plan.id, plan.subtasks);
	return { orchestrator, plan, called, contexts, revision };
}

test('accepted reassignment dispatches only the new specialist and preserves declared scope access', async () => {
	const f = fixture(); f.orchestrator.reassignPlanSubtask('owner', f.plan.id, 'one', 'anton-test', f.revision());
	assert.deepEqual(f.plan.scopeDeclaration.entries, [{ subtaskId: 'one', agent: 'anton-test', files: ['file.ts'], accessType: 'read' }]);
	const events: AgentEvent[] = [];
	await f.orchestrator.handleChatRequest({ prompt: '', command: 'approve', conversationId: 'owner' }, { history: [] }, { markdown() {} } as ChatStreamLike, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }, event => events.push(event));
	assert.deepEqual(f.called, ['anton-test']); assert.deepEqual(f.contexts[0].scopeFiles, ['file.ts']);
	assert.ok(events.some(event => event.type === 'subtask-started' && event.assignee === 'anton-test'));
	assert.equal(events.some(event => event.type === 'error'), false);
});

test('foreign, replaced, approved, running and missing-task plans reject without changing assignments', () => {
	for (const invalid of ['foreign', 'replaced', 'approved', 'running', 'missing-task', 'unregistered', 'scope'] as const) {
		const f = fixture(); const revision = f.revision();
		if (invalid === 'approved') { f.plan.approved = true; }
		if (invalid === 'running') { f.plan.subtasks[0].status = 'in_progress'; }
		if (invalid === 'scope') { f.plan.scopeDeclaration.entries = []; }
		const before = JSON.stringify(f.plan);
		assert.throws(() => f.orchestrator.reassignPlanSubtask(invalid === 'foreign' ? 'other' : 'owner', invalid === 'replaced' ? 'old-plan' : f.plan.id, invalid === 'missing-task' ? 'missing' : 'one', invalid === 'unregistered' ? 'retired-agent' : 'anton-test', revision));
		assert.equal(JSON.stringify(f.plan), before, invalid);
	}
});

test('revisions reject intervening dependency, scope, instruction and assignment edits', () => {
	for (const change of ['dependency', 'scope', 'instruction', 'assignee'] as const) {
		const f = fixture(); const previous = f.revision();
		if (change === 'dependency') { f.plan.subtasks.push({ ...f.plan.subtasks[0], id: 'two', scopeFiles: [], dependencies: [] }); f.orchestrator.updatePlanDependencies('owner', 'one', ['two'], ['one', 'two']); }
		if (change === 'scope') { f.plan.subtasks[0].scopeFiles.push('new.ts'); }
		if (change === 'instruction') { f.plan.subtasks[0].instruction = 'Changed requirement'; }
		if (change === 'assignee') { f.orchestrator.reassignPlanSubtask('owner', f.plan.id, 'one', 'anton-test', previous); }
		const before = JSON.stringify(f.plan); assert.throws(() => f.orchestrator.reassignPlanSubtask('owner', f.plan.id, 'one', 'anton-code', previous), /changed/); assert.equal(JSON.stringify(f.plan), before);
	}
});


test('chained reassignment retains the correct declaration when two tasks share files with different access', () => {
	const f = fixture(); f.orchestrator.registerSpecialist({ handle: 'anton-security' } as BaseAgent);
	f.plan.subtasks.push({ ...f.plan.subtasks[0], id: 'security', assignee: 'anton-security' });
	f.plan.scopeDeclaration.entries = [{ agent: 'anton-security', files: ['file.ts'], accessType: 'read' }, { agent: 'anton-code', files: ['file.ts'], accessType: 'write' }];
	f.orchestrator.reassignPlanSubtask('owner', f.plan.id, 'one', 'anton-security', f.revision());
	f.orchestrator.reassignPlanSubtask('owner', f.plan.id, 'one', 'anton-test', f.revision());
	assert.deepEqual(f.plan.scopeDeclaration.entries, [{ agent: 'anton-security', files: ['file.ts'], accessType: 'read' }, { subtaskId: 'one', agent: 'anton-test', files: ['file.ts'], accessType: 'write' }]);
	f.plan.scopeDeclaration.entries = [{ agent: 'anton-test', files: ['file.ts'], accessType: 'read' }, { agent: 'anton-test', files: ['file.ts'], accessType: 'write' }];
	const before = JSON.stringify(f.plan); assert.throws(() => f.orchestrator.reassignPlanSubtask('owner', f.plan.id, 'one', 'anton-code', f.revision()), /unambiguous/); assert.equal(JSON.stringify(f.plan), before);
});

test('new proposed plans expose execution identities and per-task scope ownership', async () => {
	const f = fixture(); Object.assign(f.orchestrator, { gatherGraphContext: async () => '', callLlm: async () => ({ text: '```json\n{"subtasks":[{"instruction":"Build","assignee":"anton-code","scopeFiles":["file.ts"],"dependencies":[]}]}\n```' }) });
	const events: AgentEvent[] = [];
	await f.orchestrator.handleChatRequest({ prompt: 'Build feature', command: 'plan', conversationId: 'owner' }, { history: [] }, { markdown() {} } as ChatStreamLike, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }, event => events.push(event));
	const event = events.find(event => event.type === 'plan-proposed'); assert.ok(event?.type === 'plan-proposed'); const plan = f.orchestrator.getActivePlan()!;
	assert.equal(event.plan.id, plan.id); assert.equal(event.plan.subtasks[0].id, plan.subtasks[0].id); assert.equal(plan.scopeDeclaration.entries[0].subtaskId, plan.subtasks[0].id);
});
