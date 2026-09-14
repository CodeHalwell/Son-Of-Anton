/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as assert from 'assert/strict';
import * as vscode from 'vscode';
import { BoardTaskRunner } from '../src/board/BoardTaskRunner';
import { TaskBoardModel } from '../src/board/TaskBoardModel';
import type { AgentBridge } from '../src/chat/AgentBridge';

suite('Saved board task execution', () => {
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() { } }) } as vscode.CancellationToken;
	test('retries a failed saved task with its conversation, model and completed dependency context', async () => {
		const board = new TaskBoardModel();
		board.setPlan('conversation', [
			{ id: 'prior', instruction: 'Inspect code', assignee: 'anton-code', scopeFiles: [], dependencies: [], state: 'done', summary: 'Use quantities' },
			{ id: 'retry', instruction: 'Fix totals', assignee: 'anton-code', scopeFiles: ['cart.js'], dependencies: ['prior'], state: 'failed' },
		]);
		let received: object | undefined;
		const bridge = { runSpecialist: async (handle, prompt, emit, _token, model, _context, conversationId) => {
			received = { handle, prompt, model, conversationId, state: board.getSnapshot('conversation')?.tasks[1].state };
			emit({ type: 'final', text: 'Fixed and tested' });
		} } satisfies Pick<AgentBridge, 'runSpecialist'>;
		try {
			await new BoardTaskRunner(board, bridge as AgentBridge).run('conversation', 'retry', token, 'claude-code-sonnet');
			assert.deepEqual(received, { handle: 'anton-code', prompt: 'Fix totals\n\nTask scope: cart.js\n\nCompleted dependency prior: Use quantities', model: 'claude-code-sonnet', conversationId: 'conversation', state: 'in-progress' });
			assert.deepEqual(board.getSnapshot('conversation')?.tasks.map(task => [task.id, task.state, task.summary]), [['prior', 'done', 'Use quantities'], ['retry', 'done', 'Fixed and tested']]);
		} finally { board.dispose(); }
	});
	test('provider failure stays retryable and unfinished dependencies prevent dispatch', async () => {
		const board = new TaskBoardModel(); let calls = 0;
		board.setPlan('c', [{ id: 'a', instruction: 'Test', assignee: 'anton-test', scopeFiles: [], dependencies: [], state: 'ready' }, { id: 'b', instruction: 'Review', assignee: 'anton-code', scopeFiles: [], dependencies: ['a'], state: 'blocked' }]);
		const bridge = { runSpecialist: async (_handle, _prompt, emit) => { calls++; emit({ type: 'error', message: 'Provider unavailable' }); } } satisfies Pick<AgentBridge, 'runSpecialist'>;
		const runner = new BoardTaskRunner(board, bridge as AgentBridge);
		try {
			await assert.rejects(runner.run('c', 'b', token), /dependencies/);
			await assert.rejects(runner.run('c', 'a', token), /Provider unavailable/);
			assert.deepEqual({ calls, state: board.getSnapshot('c')?.tasks[0].state }, { calls: 1, state: 'failed' });
		} finally { board.dispose(); }
	});
	test('a declined tool cannot become Done just because the agent returns a final response', async () => {
		const board = new TaskBoardModel();
		board.setPlan('c', [{ id: 'a', instruction: 'Run tests', assignee: 'anton-test', scopeFiles: [], dependencies: [], state: 'ready' }]);
		const bridge = { runSpecialist: async (_handle, _prompt, emit) => {
			emit({ type: 'tool-call', id: 'test', name: 'Bash', input: {}, status: 'error', output: 'Permission declined' });
			emit({ type: 'final', text: 'Tests could not be run.' });
		} } satisfies Pick<AgentBridge, 'runSpecialist'>;
		try {
			await assert.rejects(new BoardTaskRunner(board, bridge as AgentBridge).run('c', 'a', token), /Permission declined/);
			assert.equal(board.getSnapshot('c')?.tasks[0].state, 'failed');
		} finally { board.dispose(); }
	});
	test('cancellation leaves the task retryable even if the agent returns late', async () => {
		const board = new TaskBoardModel(); const cancelled = { ...token, isCancellationRequested: false };
		board.setPlan('c', [{ id: 'a', instruction: 'Run tests', assignee: 'anton-test', scopeFiles: [], dependencies: [], state: 'ready' }]);
		const bridge = { runSpecialist: async (_handle, _prompt, emit) => { cancelled.isCancellationRequested = true; emit({ type: 'final', text: 'Late result' }); } } satisfies Pick<AgentBridge, 'runSpecialist'>;
		try {
			await assert.rejects(new BoardTaskRunner(board, bridge as AgentBridge).run('c', 'a', cancelled), /cancelled/);
			assert.equal(board.getSnapshot('c')?.tasks[0].state, 'failed');
		} finally { board.dispose(); }
	});

});
