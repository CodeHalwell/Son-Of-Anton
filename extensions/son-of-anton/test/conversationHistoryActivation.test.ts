/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { activateConversationHistory } from '../src/chat/activateConversationHistory';
import { ConversationStorage } from '../src/chat/ConversationStorage';

suite('Conversation history activation', () => {
	test('unwritable migration storage preserves history and returns a usable chat store', async () => {
		const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-history-activation-'));
		const save = ConversationStorage.prototype.save;
		ConversationStorage.prototype.save = async () => { throw new Error('ENOSPC: no space left on device'); };
		const message = { role: 'user', content: 'Keep my original conversation', timestamp: 1 };
		const values = new Map<string, object>([['sota.conversations.index', [{ id: 'original', title: 'Original', messageCount: 1, createdAt: 1, updatedAt: 1 }]], ['sota.conversations.original', [message]]]);
		const state = { get: <T>(key: string) => values.get(key) as T | undefined, update: async (key: string, value: object | undefined) => { if (value === undefined) { values.delete(key); } else { values.set(key, value); } } };
		const subscriptions: vscode.Disposable[] = [];
		const context = { globalStorageUri: vscode.Uri.file(directory), globalState: state, workspaceState: { get: () => undefined, update: async () => {} }, subscriptions } as unknown as vscode.ExtensionContext;
		const warnings: string[] = [], originalWarning = vscode.window.showWarningMessage;
		vscode.window.showWarningMessage = (async (text: string) => { warnings.push(text); return undefined; }) as typeof vscode.window.showWarningMessage;
		try {
			const store = await activateConversationHistory(context);
			const newChat = store.create([]);
			await assert.rejects(store.flush());
			assert.deepEqual({ original: store.load('original')?.messages[0].content, legacyRetained: values.has('sota.conversations.original'), newChat: store.load(newChat.summary.id)?.messages.length, registered: subscriptions.includes(store), degradedWarning: warnings.some(text => text.includes('Chat remains available')) }, { original: message.content, legacyRetained: true, newChat: 0, registered: true, degradedWarning: true });
		} finally {
			ConversationStorage.prototype.save = save;
			vscode.window.showWarningMessage = originalWarning;
			for (const disposable of subscriptions) { disposable.dispose(); }
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
