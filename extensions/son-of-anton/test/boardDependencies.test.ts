/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { TaskBoardModel, type BoardTask } from '../src/board/TaskBoardModel';
import { dependencyRevision, dependencySchedule } from '../src/board/webview/dependencyGraph';
import { parseBoardAssistantProposal } from '../src/board/BoardAssistantProposal';

suite('Board dependency planning and agent proposals', () => {
	const tasks = (): BoardTask[] => [
		{ id: 'a', instruction: 'Foundation', assignee: 'anton-code', scopeFiles: [], dependencies: [], state: 'ready' },
		{ id: 'b', instruction: 'Interface', assignee: 'anton-ui', scopeFiles: [], dependencies: ['a'], state: 'backlog' },
		{ id: 'c', instruction: 'Tests', assignee: 'anton-test', scopeFiles: [], dependencies: ['a'], state: 'backlog' },
	];
	test('schedule exposes parallel waves, blockers and cycles without changing the source plan', () => {
		const source = tasks();
		assert.deepEqual(dependencySchedule(source), { waves: [['a'], ['b', 'c']], blocking: { a: [], b: ['a'], c: ['a'] } });
		assert.throws(() => dependencySchedule(source.map(task => task.id === 'a' ? { ...task, dependencies: ['b'] } : task)), /cycle/);
		assert.throws(() => dependencySchedule(source.map(task => task.id === 'a' ? { ...task, dependencies: ['missing'] } : task)), /missing/);
		assert.deepEqual(source[0].dependencies, []);
	});
	test('dependency commit rejects stale previews and running plans', () => {
		const model = new TaskBoardModel(); model.setPlan('conversation', tasks());
		try {
			const revision = dependencyRevision(model.getSnapshot('conversation')!.tasks);
			const preview = model.previewDependencies('conversation', 'c', ['b'], revision);
			assert.deepEqual(preview.schedule.waves, [['a'], ['b'], ['c']]);
			model.setDependencies('conversation', 'c', ['b'], revision);
			assert.throws(() => model.setDependencies('conversation', 'c', [], revision), /changed/);
			model.updateTask('conversation', 'a', { state: 'in-progress' });
			assert.throws(() => model.previewDependencies('conversation', 'c', [], dependencyRevision(model.getSnapshot('conversation')!.tasks)), /running/);
		} finally { model.dispose(); }
	});
	test('ACP textual proposals allow only validated Board actions and retain explanatory prose', () => {
		const result = parseBoardAssistantProposal('I suggest reassigning this task.\n```board-actions\n[{"action":"setCardAssignee","cardId":"a","assignee":"anton-ui"}]\n```');
		assert.deepEqual(result, { text: 'I suggest reassigning this task.', actions: [{ action: 'setCardAssignee', cardId: 'a', assignee: 'anton-ui', type: 'board-action' }] });
		assert.throws(() => parseBoardAssistantProposal('```board-actions\n[{"action":"shell","command":"rm"}]\n```'), /unsupported/);
		assert.throws(() => parseBoardAssistantProposal('```board-actions\ninvalid\n```'), /malformed/);
	});
});
