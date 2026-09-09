/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { OrchestratorAgent } from 'son-of-anton-core/agents/OrchestratorAgent';
import type { ExecutionPlan } from 'son-of-anton-core/agents/types';
import { AgentBridge } from '../src/chat/AgentBridge';
import { TaskBoardModel } from '../src/board/TaskBoardModel';
import { TaskBoardPanel } from '../src/board/TaskBoardPanel';
import { reassignBoardTask, refreshBoardPlan } from '../src/board/BoardReassignment';
import { boardEditRevision } from '../src/board/webview/dependencyGraph';

function fixture() {
	const plan: ExecutionPlan = { id: 'plan-one', conversationId: 'owner', originalRequest: 'Build', approved: false, scopeDeclaration: { entries: [] }, subtasks: [{ id: 'one', assignee: 'anton-code', instruction: 'Build feature', dependencies: [], scopeFiles: [], status: 'pending', retryCount: 0 }] };
	const orchestrator = Object.assign(Object.create(OrchestratorAgent.prototype), { activePlan: plan, specialists: new Map([['anton-code', { handle: 'anton-code' }], ['anton-test', { handle: 'anton-test' }]]) }) as OrchestratorAgent;
	const bridge = Object.assign(Object.create(AgentBridge.prototype), { stack: { orchestrator } }) as AgentBridge;
	const model = new TaskBoardModel(); const seed = (conversation = 'owner', planId = plan.id) => model.setPlan(conversation, plan.subtasks.map(task => ({ ...task, state: 'ready' })), planId); seed(); seed('other');
	const snapshots: Array<{ snapshot: { executionPlanId?: string; tasks: Array<{ id: string }> } }> = [];
	const panel = Object.assign(Object.create(TaskBoardPanel.prototype), { conversationStore: { list: () => [] }, panel: { webview: { postMessage: (message: typeof snapshots[number]) => { snapshots.push(message); } } }, currentConversationId: 'owner', conversationGeneration: 0, closed: false, boardActionQueue: Promise.resolve(), activeChatStreams: new Map(), pendingReruns: new Set(), model, handlers: { refreshPlan: (conversationId: string) => refreshBoardPlan(model, bridge, conversationId), reassignSubtask: (conversationId: string, taskId: string, assignee: string, revision: string) => reassignBoardTask(model, bridge, conversationId, taskId, assignee, revision) } }) as { handleMessage(message: object): void; boardActionQueue: Promise<void>; currentConversationId: string };
	const revision = () => boardEditRevision(model.getSnapshot(panel.currentConversationId)!);
	const send = (expectedRevision = revision(), conversationId = panel.currentConversationId) => panel.handleMessage({ type: 'reassign', conversationId, taskId: 'one', newAssignee: 'anton-test', expectedRevision });
	return { plan, orchestrator, model, bridge, panel, seed, revision, send, snapshots };
}

suite('Board reassignment execution integration', () => {
	test('direct and confirmed proposal paths commit through the bridge before Board notification', async () => {
		const original = vscode.window.showInformationMessage;
		Object.assign(vscode.window, { showInformationMessage: async (_message: string, _options: object, action: string) => action });
		try { for (const proposal of [false, true]) {
			const f = fixture(); let changes = 0; const subscription = f.model.onDidChangeBoard(() => { changes++; assert.equal(f.plan.subtasks[0].assignee, 'anton-test'); });
			try {
				if (proposal) { f.panel.handleMessage({ type: 'board-action', conversationId: 'owner', action: 'setCardAssignee', cardId: 'one', assignee: 'anton-test' }); await f.panel.boardActionQueue; } else { f.send(); }
				assert.deepEqual({ plan: f.plan.subtasks[0].assignee, board: f.model.getSnapshot('owner')!.tasks[0].assignee, changes }, { plan: 'anton-test', board: 'anton-test', changes: 1 });
			} finally { subscription.dispose(); f.model.dispose(); }
		} } finally { Object.assign(vscode.window, { showInformationMessage: original }); }
	});

	test('stale direct commands and core rejections preserve both plans and visible assignments', () => {
		const original = vscode.window.showErrorMessage; const errors: string[] = []; Object.assign(vscode.window, { showErrorMessage: async (message: string) => { errors.push(message); } });
		try { for (const invalid of ['stale-board', 'replaced-plan', 'foreign', 'running', 'legacy', 'changed-core'] as const) {
			const f = fixture(); const old = f.revision();
			try {
				if (invalid === 'stale-board') { f.model.updateTask('owner', 'one', { scopeFiles: ['new.ts'] }); }
				if (invalid === 'replaced-plan') { f.seed('owner', 'other-plan'); }
				if (invalid === 'foreign') { f.panel.currentConversationId = 'other'; }
				if (invalid === 'running') { f.plan.approved = true; f.plan.subtasks[0].status = 'in_progress'; }
				if (invalid === 'legacy') { f.model.setPlan('owner', f.model.getSnapshot('owner')!.tasks.map(task => ({ ...task }))); }
				if (invalid === 'changed-core') { f.plan.subtasks[0].instruction = 'New requirements'; }
				const before = JSON.stringify(f.plan); f.send(invalid === 'legacy' || invalid === 'foreign' ? f.revision() : old);
				assert.equal(JSON.stringify(f.plan), before); assert.equal(f.model.getSnapshot(f.panel.currentConversationId)!.tasks[0].assignee, 'anton-code');
			} finally { f.model.dispose(); }
		} assert.equal(errors.length, 6); } finally { Object.assign(vscode.window, { showErrorMessage: original }); }
	});

	test('refresh restores real execution identities in serialized snapshots and preserves foreign boards', () => {
		const f = fixture(); try {
			f.model.setPlan('owner', [{ ...f.model.getSnapshot('owner')!.tasks[0], id: 'legacy-card' }]);
			f.panel.handleMessage({ type: 'refresh' });
			assert.deepEqual({ id: f.snapshots.at(-1)!.snapshot.executionPlanId, tasks: f.snapshots.at(-1)!.snapshot.tasks.map(task => task.id) }, { id: f.plan.id, tasks: ['one'] });
			f.send(); assert.equal(f.plan.subtasks[0].assignee, 'anton-test');
			f.panel.currentConversationId = 'other'; const before = JSON.stringify(f.model.getSnapshot('other')); f.panel.handleMessage({ type: 'refresh' }); assert.equal(JSON.stringify(f.model.getSnapshot('other')), before);
		} finally { f.model.dispose(); }
	});

	test('an obsolete conversation envelope is ignored after switching boards', () => {
		const f = fixture(); try { const old = f.revision(); f.panel.currentConversationId = 'other'; f.send(old, 'owner'); assert.equal(f.plan.subtasks[0].assignee, 'anton-code'); assert.equal(f.model.getSnapshot('other')!.tasks[0].assignee, 'anton-code'); } finally { f.model.dispose(); }
	});
});
