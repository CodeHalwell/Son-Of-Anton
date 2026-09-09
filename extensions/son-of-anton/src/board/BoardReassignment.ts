/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { planEditRevision } from 'son-of-anton-core/agents/planEditing';
import type { ExecutionPlan } from 'son-of-anton-core/agents/types';
import type { TaskBoardModel } from './TaskBoardModel';
import { boardEditRevision } from './webview/dependencyGraph';

interface PlanEditor {
	reassignPlanSubtask(conversationId: string, planId: string, taskId: string, newAssignee: string, expectedRevision: string): void;
}

/** The execution plan commits first; rejection cannot leave a successful-looking Board assignment. */
export function reassignBoardTask(model: TaskBoardModel, editor: PlanEditor, conversationId: string, taskId: string, newAssignee: string, expectedRevision: string): void {
	const snapshot = model.getSnapshot(conversationId);
	if (!snapshot || boardEditRevision(snapshot) !== expectedRevision) { throw new Error('Board changed. Review its current assignment before trying again.'); }
	if (!snapshot.executionPlanId) { throw new Error('This board has no editable execution plan. Generate a new plan before reassigning tasks.'); }
	editor.reassignPlanSubtask(conversationId, snapshot.executionPlanId, taskId, newAssignee, planEditRevision(snapshot.executionPlanId, snapshot.tasks));
	model.reassign(conversationId, taskId, newAssignee);
}

/** Recover current execution identities without replacing another conversation's Board. */
export function refreshBoardPlan(model: TaskBoardModel, editor: { getActivePlan(): ExecutionPlan | undefined }, conversationId: string): void {
	const plan = editor.getActivePlan(); if (!plan || plan.conversationId !== conversationId) { return; }
	const existing = model.getSnapshot(conversationId);
	model.setPlan(conversationId, plan.subtasks.map(task => ({
		...existing?.tasks.find(previous => previous.id === task.id),
		id: task.id, instruction: task.instruction, assignee: task.assignee, scopeFiles: task.scopeFiles, dependencies: task.dependencies,
		state: task.status === 'in_progress' ? 'in-progress' : task.status === 'completed' ? 'done' : task.status === 'failed' ? 'failed' : 'backlog',
	})), plan.id);
}
