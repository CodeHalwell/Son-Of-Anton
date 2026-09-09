/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ConversationActions } from '../src/chat/ConversationActions';
import type { ConversationRecord, ConversationStore } from '../src/chat/ConversationStore';
import type { ModelId } from 'son-of-anton-core/llm/LlmClient';

suite('Conversation actions', () => {
	let restore: () => void;
	setup(() => {
		const { showInputBox, showWarningMessage } = vscode.window;
		restore = () => Object.assign(vscode.window, { showInputBox, showWarningMessage });
	});
	teardown(() => restore());

	function fixture() {
		const record = (id: string): ConversationRecord => ({ summary: { id, title: id, createdAt: 1, updatedAt: 1, messageCount: 0 }, messages: [] });
		const records = new Map([['first', record('first')], ['second', record('second')]]);
		let active = 'first';
		const store = {
			getInitialConversation: () => records.get(active),
			load: (id: string) => records.get(id),
			create: () => { const fresh = record('fresh'); records.set('fresh', fresh); return fresh; },
			update: (id: string, _messages: [], _specialist: undefined, _mode: undefined, _tab: undefined, lastModel: ModelId) => {
				const entry = records.get(id)!; records.set(id, { ...entry, summary: { ...entry.summary, lastModel } });
			},
			rename: (id: string, title: string) => { const entry = records.get(id); if (entry) { records.set(id, { ...entry, summary: { ...entry.summary, title } }); } },
			delete: (id: string) => records.delete(id),
		} as unknown as ConversationStore;
		return { actions: new ConversationActions(store), records, select: (id: string) => { active = id; } };
	}

	test('New Conversation carries the selected model without copying messages or plan state', () => {
		const f = fixture();
		const previous = f.records.get('first')!;
		f.records.set('first', { summary: { ...previous.summary, lastModel: 'claude-code-opus', lastMode: 'plan', lastSpecialist: 'anton-code', lastTab: 'history' }, messages: [{ role: 'user', content: 'Previous task', timestamp: 1 }] });
		const fresh = f.actions.create();
		assert.deepEqual({ model: fresh.summary.lastModel, mode: fresh.summary.lastMode, specialist: fresh.summary.lastSpecialist, tab: fresh.summary.lastTab, messages: fresh.messages }, { model: 'claude-code-opus', mode: undefined, specialist: undefined, tab: undefined, messages: [] });
	});

	test('rename works for history ids, tree entries, and the active palette conversation', async () => {
		const f = fixture();
		Object.assign(vscode.window, { showInputBox: async () => 'Renamed' });
		await f.actions.rename('first');
		await f.actions.rename({ summary: { id: 'second' } });
		Object.assign(vscode.window, { showInputBox: async () => 'Palette rename' });
		await f.actions.rename();
		assert.deepEqual([...f.records.values()].map(entry => entry.summary.title), ['Palette rename', 'Renamed']);
	});

	test('a confirmed deletion targets the original selection even if the active chat changes', async () => {
		const f = fixture();
		let finish!: (answer: string) => void;
		let dialogs = 0;
		Object.assign(vscode.window, { showWarningMessage: () => { dialogs++; return new Promise<string>(resolve => { finish = resolve; }); } });
		const pending = f.actions.delete('first');
		await f.actions.delete('first');
		f.select('second'); finish('Move to Trash'); await pending;
		assert.deepEqual({ dialogs, remaining: [...f.records.keys()] }, { dialogs: 1, remaining: ['second'] });
	});

	test('dismissal and missing ids do not delete or rename another conversation', async () => {
		const f = fixture();
		Object.assign(vscode.window, { showInputBox: async () => undefined, showWarningMessage: async () => undefined });
		await f.actions.delete('first'); await f.actions.rename('first');
		Object.assign(vscode.window, { showInputBox: () => assert.fail('Unexpected dialog'), showWarningMessage: () => assert.fail('Unexpected dialog') });
		await f.actions.delete('missing'); await f.actions.rename('missing');
		assert.deepEqual([...f.records.values()].map(entry => entry.summary.title), ['first', 'second']);
	});
});
