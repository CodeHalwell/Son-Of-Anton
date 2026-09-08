/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ChatSession } from '../src/chat/ChatPanel';

interface SettingsSession {
	handleResetAllSettings(): Promise<void>;
	handleMcpServerDelete(message: { name: string }): Promise<void>;
}

suite('Native settings confirmations', () => {
	const originalWarning = vscode.window.showWarningMessage;
	const originalConfiguration = vscode.workspace.getConfiguration;
	teardown(() => {
		vscode.window.showWarningMessage = originalWarning;
		vscode.workspace.getConfiguration = originalConfiguration;
	});

	for (const approve of [false, true]) {
		test(`${approve ? 'confirm' : 'cancel'} protects settings and server deletion at the host boundary`, async () => {
			const updates: string[] = [];
			const servers = [{ name: 'keep', command: 'node' }, { name: 'remove', command: 'node' }];
			let remaining = servers;
			vscode.window.showWarningMessage = (async (_message: string, _options: vscode.MessageOptions, action: vscode.MessageItem) => approve ? action : undefined) as typeof vscode.window.showWarningMessage;
			vscode.workspace.getConfiguration = (() => ({
				get: (key: string) => key === 'mcp.servers' ? servers : undefined,
				update: async (key: string, value: typeof servers) => { updates.push(key); if (key === 'mcp.servers') { remaining = value; } },
			})) as typeof vscode.workspace.getConfiguration;
			const session = Object.assign(Object.create(ChatSession.prototype), {
				webview: { postMessage: () => Promise.resolve(true) },
				postSettingsState: () => {}, postMcpServersState: async () => {},
			}) as SettingsSession;
			await session.handleResetAllSettings();
			await session.handleMcpServerDelete({ name: 'remove' });
			if (approve) {
				assert.ok(updates.includes('personality.antonIsWatchingFrequency'));
				assert.ok(updates.every(key => !/apiKey|credentials|secret/i.test(key)));
				assert.deepEqual(remaining.map(server => server.name), ['keep']);
			} else {
				assert.deepEqual({ updates, remaining }, { updates: [], remaining: servers });
			}
		});
	}
});
