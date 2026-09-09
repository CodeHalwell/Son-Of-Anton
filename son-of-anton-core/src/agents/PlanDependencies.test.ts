/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrchestratorAgent } from './OrchestratorAgent';
import type { ExecutionPlan } from './types';

test('Board dependency edits change only an idle plan owned by the requested conversation', () => {
	const plan: ExecutionPlan = { id: 'plan', conversationId: 'owner', originalRequest: 'Build', scopeDeclaration: { entries: [] }, approved: false, subtasks: ['a', 'b', 'c'].map(id => ({ id, instruction: id, assignee: 'anton-code', scopeFiles: [], dependencies: id === 'a' ? [] : ['a'], status: 'pending', retryCount: 0 })) };
	const orchestrator = Object.assign(Object.create(OrchestratorAgent.prototype), { activePlan: plan }) as OrchestratorAgent;
	orchestrator.updatePlanDependencies('owner', 'c', ['b'], ['a', 'b', 'c']);
	assert.deepEqual(plan.subtasks[2].dependencies, ['b']);
	assert.throws(() => orchestrator.updatePlanDependencies('other', 'c', [], ['a', 'b', 'c']), /owning conversation/);
	assert.throws(() => orchestrator.updatePlanDependencies('owner', 'a', ['c'], ['a', 'b', 'c']), /cycle/);
	assert.throws(() => orchestrator.updatePlanDependencies('owner', 'c', [], ['a', 'b']), /changed/);
	plan.approved = true;
	assert.throws(() => orchestrator.updatePlanDependencies('owner', 'c', [], ['a', 'b', 'c']), /pending, unapproved/);
	assert.deepEqual(plan.subtasks[2].dependencies, ['b']);
});
