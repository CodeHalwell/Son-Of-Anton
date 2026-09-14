/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as assert from 'assert/strict';
import * as vscode from 'vscode';
import { ChatSession } from '../src/chat/ChatPanel';

suite('Checkpoint comparison', () => {
	test('opens changed files, including additions and deletions, in a changes editor', async () => {
		const original = { getExtension: vscode.extensions.getExtension, folders: vscode.workspace.workspaceFolders, command: vscode.commands.executeCommand };
		const file = (name: string) => vscode.Uri.file(`/fixture/${name}`);
		const change = (name: string, status: number) => ({ uri: file(name), originalUri: file(name), status });
		const sha = 'a'.repeat(40);
		let received: unknown[] | undefined;
		const api = {
			getRepository: () => ({ rootUri: file(''), status: async () => {}, diffWith: async (ref: string) => { assert.equal(ref, sha); return [change('edited.ts', 5), change('added.ts', 1), change('deleted.ts', 6), change('captured.ts', 6)]; }, getObjectDetails: async (_ref: string, name: string) => { if (name === 'captured.ts') return {}; throw new Error('Not in checkpoint'); }, state: { untrackedChanges: [change('new.ts', 7)], workingTreeChanges: [change('captured.ts', 7)] } }),
			toGitUri: (uri: vscode.Uri, ref: string) => ({ path: uri.fsPath, ref }),
		};
		Object.assign(vscode.extensions, { getExtension: () => ({ isActive: true, exports: { getAPI: () => api } }) });
		Object.assign(vscode.workspace, { workspaceFolders: [{ uri: file(''), name: 'fixture', index: 0 }] });
		Object.assign(vscode.commands, { executeCommand: async (...args: unknown[]) => { received = args; } });
		try {
			const session = Object.assign(Object.create(ChatSession.prototype), { checkpointManager: { get: () => ({ gitSha: sha }) } }) as { handleCheckpointCompare(id: string): Promise<void> };
			await session.handleCheckpointCompare('fixture');
			assert.equal(JSON.stringify(received), JSON.stringify(['vscode.changes', 'Checkpoint aaaaaaa ↔ Working Tree', [
				[file('edited.ts'), { path: '/fixture/edited.ts', ref: sha }, file('edited.ts')],
				[file('added.ts'), undefined, file('added.ts')],
				[file('deleted.ts'), { path: '/fixture/deleted.ts', ref: sha }, undefined],
				[file('captured.ts'), { path: '/fixture/captured.ts', ref: sha }, file('captured.ts')],
				[file('new.ts'), undefined, file('new.ts')],
			]]));
		} finally {
			vscode.extensions.getExtension = original.getExtension;
			Object.assign(vscode.workspace, { workspaceFolders: original.folders });
			vscode.commands.executeCommand = original.command;
		}
	});
});
