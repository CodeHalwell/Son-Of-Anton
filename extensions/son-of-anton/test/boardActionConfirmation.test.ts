/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { getRoster } from 'son-of-anton-core/chat/personas';
import { TaskBoardPanel } from '../src/board/TaskBoardPanel';
import { TaskBoardModel, type BoardTask } from '../src/board/TaskBoardModel';
import { buildBoardActions } from '../src/board/webview/boardActionDefs';
import type { BoardActionMessage, PersonaView } from '../src/board/webview/protocol';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
interface PanelHarness {
	currentConversationId: string | undefined;
	boardActionQueue: Promise<void>;
	handleMessage(message: object): void;
	switchConversation(id: string): void;
	dispose(): void;
}
interface Confirmation {
	detail: string;
	action: string;
	resolve(answer?: string): void;
}
function fixture() {
	const model = new TaskBoardModel();
	const tasks = (): BoardTask[] => [{ id: 'one', instruction: 'Build feature', assignee: 'anton-code', dependencies: [], scopeFiles: [], state: 'ready' }];
	model.setPlan('first', tasks()); model.setPlan('second', tasks());
	const snapshots: Array<{ type: string; personas?: PersonaView[] }> = [];
	const panel = Object.assign(Object.create(TaskBoardPanel.prototype), {
		currentConversationId: 'first', conversationGeneration: 0, closed: false,
		boardActionQueue: Promise.resolve(), activeChatStreams: new Map(), pendingReruns: new Set(), disposables: [], model,
		panel: { dispose() {}, webview: { postMessage: (message: typeof snapshots[number]) => { snapshots.push(message); } } },
		conversationStore: { list: () => [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }] },
		handlers: { reassignSubtask: (conversationId: string, taskId: string, assignee: string) => model.reassign(conversationId, taskId, assignee) },
	}) as PanelHarness;
	const send = (action: Omit<BoardActionMessage, 'type'>, conversationId = 'first') => panel.handleMessage({ type: 'board-action', conversationId, ...action });
	return { panel, model, snapshots, send };
}
async function withFixture(run: (f: ReturnType<typeof fixture> & { confirmations: Confirmation[]; errors: string[] }) => Promise<void>): Promise<void> {
	const originals = { information: vscode.window.showInformationMessage, error: vscode.window.showErrorMessage };
	const confirmations: Confirmation[] = []; const errors: string[] = [];
	Object.assign(vscode.window, {
		showInformationMessage: (_message: string, options: { detail: string }, action: string) => new Promise<string | undefined>(resolve => { confirmations.push({ detail: options.detail, action, resolve }); }),
		showErrorMessage: async (message: string) => { errors.push(message); },
	});
	const f = fixture();
	try { await run({ ...f, confirmations, errors }); }
	finally {
		f.panel.dispose(); for (const confirmation of confirmations) { confirmation.resolve(); }
		await f.panel.boardActionQueue; f.model.dispose();
		Object.assign(vscode.window, { showInformationMessage: originals.information, showErrorMessage: originals.error });
	}
}

suite('Board assistant proposal confirmations', () => {
	test('three proposals are reviewed serially against revisions left by accepted predecessors', async () => {
		await withFixture(async f => {
			f.send({ action: 'setCardStatus', cardId: 'one', toColumn: 'review' });
			f.send({ action: 'setCardAssignee', cardId: 'one', assignee: 'anton-test' });
			f.send({ action: 'addCard', instruction: 'Document the result', assignee: 'anton-docs' });
			await tick(); assert.equal(f.confirmations.length, 1);
			f.confirmations[0].resolve(f.confirmations[0].action); await tick();
			assert.deepEqual({ dialogs: f.confirmations.length, state: f.model.getSnapshot('first')!.tasks[0].state }, { dialogs: 2, state: 'review' });
			f.confirmations[1].resolve(f.confirmations[1].action); await tick();
			assert.deepEqual({ dialogs: f.confirmations.length, assignee: f.model.getSnapshot('first')!.tasks[0].assignee }, { dialogs: 3, assignee: 'anton-test' });
			f.confirmations[2].resolve(f.confirmations[2].action); await f.panel.boardActionQueue;
			assert.deepEqual({ tasks: f.model.getSnapshot('first')!.tasks.map(task => [task.instruction, task.assignee]), errors: f.errors }, { tasks: [['Build feature', 'anton-test'], ['Document the result', 'anton-docs']], errors: [] });
		});
	});

	test('a declined proposal does not prevent the next accepted proposal from applying', async () => {
		await withFixture(async f => {
			f.send({ action: 'setCardStatus', cardId: 'one', toColumn: 'done' });
			f.send({ action: 'setCardAssignee', cardId: 'one', assignee: 'anton-test' });
			await tick(); f.confirmations[0].resolve(); await tick();
			f.confirmations[1].resolve(f.confirmations[1].action); await f.panel.boardActionQueue;
			assert.deepEqual({ state: f.model.getSnapshot('first')!.tasks[0].state, assignee: f.model.getSnapshot('first')!.tasks[0].assignee, errors: f.errors }, { state: 'ready', assignee: 'anton-test', errors: [] });
		});
	});

	test('unregistered assignees are rejected even when present on the board, and do not poison the queue', async () => {
		await withFixture(async f => {
			f.model.reassign('first', 'one', 'retired-agent');
			f.send({ action: 'addCard', instruction: 'Invalid owner', assignee: 'retired-agent' });
			f.send({ action: 'setCardAssignee', cardId: 'one', assignee: 'nonexistent-agent' });
			f.send({ action: 'setCardAssignee', cardId: 'one', assignee: 'anton-docs' });
			await tick(); assert.equal(f.confirmations.length, 1);
			f.confirmations[0].resolve(f.confirmations[0].action); await f.panel.boardActionQueue;
			assert.deepEqual({ tasks: f.model.getSnapshot('first')!.tasks.map(task => task.assignee), errors: f.errors }, { tasks: ['anton-docs'], errors: ['Error: Proposed assignee is not a registered specialist.', 'Error: Proposed assignee is not a registered specialist.'] });
		});
	});

	test('external board changes invalidate an open confirmation but later proposals get a fresh revision', async () => {
		await withFixture(async f => {
			f.send({ action: 'setCardStatus', cardId: 'one', toColumn: 'done' });
			f.send({ action: 'setCardAssignee', cardId: 'one', assignee: 'anton-test' });
			await tick(); f.model.updateTask('first', 'one', { state: 'review' });
			f.confirmations[0].resolve(f.confirmations[0].action); await tick();
			f.confirmations[1].resolve(f.confirmations[1].action); await f.panel.boardActionQueue;
			assert.deepEqual({ state: f.model.getSnapshot('first')!.tasks[0].state, assignee: f.model.getSnapshot('first')!.tasks[0].assignee, errors: f.errors }, { state: 'review', assignee: 'anton-test', errors: ['Error: Board changed while reviewing this proposal. Ask for a fresh proposal.'] });
		});
	});

	test('switching away and back invalidates both the open confirmation and older queued proposals', async () => {
		await withFixture(async f => {
			f.send({ action: 'setCardStatus', cardId: 'one', toColumn: 'done' });
			f.send({ action: 'addCard', instruction: 'Obsolete queued proposal', assignee: 'anton-code' });
			await tick(); f.panel.switchConversation('second'); f.panel.switchConversation('first');
			f.send({ action: 'setCardAssignee', cardId: 'one', assignee: 'anton-docs' });
			f.confirmations[0].resolve(f.confirmations[0].action); await tick();
			assert.equal(f.confirmations.length, 2);
			f.confirmations[1].resolve(f.confirmations[1].action); await f.panel.boardActionQueue;
			assert.deepEqual({ first: f.model.getSnapshot('first')!.tasks.map(task => [task.state, task.assignee]), second: f.model.getSnapshot('second')!.tasks.map(task => [task.state, task.assignee]), errors: f.errors }, { first: [['ready', 'anton-docs']], second: [['ready', 'anton-code']], errors: [] });
		});
	});

	test('disposing the board prevents open and queued proposals from mutating it', async () => {
		await withFixture(async f => {
			f.send({ action: 'setCardStatus', cardId: 'one', toColumn: 'done' });
			f.send({ action: 'addCard', instruction: 'Obsolete queued proposal' });
			await tick(); f.panel.dispose(); f.confirmations[0].resolve(f.confirmations[0].action); await f.panel.boardActionQueue;
			assert.deepEqual({ dialogs: f.confirmations.length, tasks: f.model.getSnapshot('first')!.tasks.map(task => task.state), errors: f.errors }, { dialogs: 1, tasks: ['ready'], errors: [] });
		});
	});

	test('the live snapshot offers unused registered specialists and omits retired handles', async () => {
		await withFixture(async f => {
			f.model.reassign('first', 'one', 'retired-agent'); f.panel.handleMessage({ type: 'refresh' });
			const assignees = f.snapshots.at(-1)!.personas!.map(persona => persona.id);
			const offered = buildBoardActions(assignees).find(action => action.name === 'setCardAssignee')!.parameters.find(parameter => parameter.name === 'assignee')!.enumValues;
			assert.deepEqual(offered, getRoster().map(persona => persona.id));
			assert.ok(assignees.includes('anton-test') && !assignees.includes('retired-agent'));
		});
	});
});
