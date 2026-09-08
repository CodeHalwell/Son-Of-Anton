/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import type { AgentManager } from 'son-of-anton-core/agents/AgentManager';
import type { CredentialBroker } from 'son-of-anton-core/auth/CredentialBroker';
import type { ProviderStatus } from 'son-of-anton-core/auth/types';
import { StatusBarManager } from '../src/sidebar/StatusBarManager';
import { HarnessStatusBarItem } from '../src/status/HarnessStatusBarItem';

suite('Connection and specialist status', () => {
	const mock = require('vscode') as typeof vscode;
	const settings = new Map<string, string | Array<{ id: string; command: string }>>();
	let items: vscode.StatusBarItem[];
	let listeners: Array<(event: vscode.ConfigurationChangeEvent) => void>;
	let restore: () => void;
	const disposable = { dispose() {} };

	setup(() => {
		settings.clear(); items = []; listeners = [];
		const original = {
			createStatusBarItem: mock.window.createStatusBarItem,
			getConfiguration: mock.workspace.getConfiguration,
			onDidChangeConfiguration: mock.workspace.onDidChangeConfiguration,
		};
		Object.assign(mock.window, { createStatusBarItem: () => {
			const item = { text: '', show() {}, dispose() {} } as vscode.StatusBarItem;
			items.push(item); return item;
		} });
		Object.assign(mock.workspace, {
			getConfiguration: (section?: string) => ({ get: (key: string, fallback?: string) => settings.get(section ? `${section}.${key}` : key) ?? fallback }),
			onDidChangeConfiguration: (listener: typeof listeners[number]) => { listeners.push(listener); return disposable; },
		});
		restore = () => {
			Object.assign(mock.window, { createStatusBarItem: original.createStatusBarItem });
			Object.assign(mock.workspace, { getConfiguration: original.getConfiguration, onDidChangeConfiguration: original.onDidChangeConfiguration });
		};
	});
	teardown(() => restore());

	function createStatus(status: () => Promise<ProviderStatus[]>) {
		return new StatusBarManager(
			{ hasActiveAgents: () => false, onDidChangeTasks: () => disposable } as unknown as AgentManager,
			{ status, onDidDisconnect: () => {} } as unknown as CredentialBroker,
		);
	}

	test('configured ACP routes are visible without an OAuth session', async () => {
		settings.set('sota.acp.agents', [{ id: 'claude-acp', command: 'claude-agent-acp' }]);
		const manager = createStatus(async () => []);
		try {
			await manager.refreshAuth();
			assert.equal(items[1].text, '$(account) Connections Configured');
			assert.equal(items[1].command, 'sota.openProviderSettings');
			assert.match((items[1].tooltip as vscode.MarkdownString).value, /1 ACP adapters configured; availability is checked when they run/);
		} finally { manager.dispose(); }
	});

	test('connected providers open management settings instead of disconnecting on click', async () => {
		const manager = createStatus(async () => [{ id: 'anthropic-oauth', displayName: 'Claude', connected: true }]);
		try {
			await manager.refreshAuth();
			assert.deepEqual({ text: items[1].text, command: items[1].command }, { text: '$(account) Claude', command: 'sota.openProviderSettings' });
		} finally { manager.dispose(); }
	});

	test('a slow earlier refresh cannot replace newer connection state', async () => {
		let finish!: (value: ProviderStatus[]) => void;
		const pending = new Promise<ProviderStatus[]>(resolve => { finish = resolve; });
		let calls = 0;
		const manager = createStatus(() => ++calls === 1 ? pending : Promise.resolve([{ id: 'latest', displayName: 'Latest', connected: true }]));
		try {
			await manager.refreshAuth();
			finish([{ id: 'stale', displayName: 'Stale', connected: true }]);
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(items[1].text, '$(account) Latest');
		} finally { manager.dispose(); }
	});

	test('harness shows missing ACP definitions and refreshes when an adapter is configured', () => {
		settings.set('sota.agents.anton-code.acpAgent', 'claude-acp');
		const harness = new HarnessStatusBarItem();
		try {
			assert.match(items[0].text, /1 ACP routes/);
			assert.match(String(items[0].tooltip), /@anton-code → claude-acp: adapter missing/);
			assert.doesNotMatch(String(items[0].tooltip), /Pinned specialists \(0\)/);
			settings.set('sota.acp.agents', [{ id: 'claude-acp', command: 'claude-agent-acp' }]);
			for (const listener of listeners) { listener({ affectsConfiguration: section => section === 'sota.acp' }); }
			assert.match(String(items[0].tooltip), /@anton-code → claude-acp: configured/);
		} finally { harness.dispose(); }
	});

	test('an explicit default model still counts as a pin, and Claude Code models show their ACP route', () => {
		settings.set('sota.agents.anton-test.model', 'sonnet');
		settings.set('sota.agents.anton-code.model', 'claude-code-opus');
		const harness = new HarnessStatusBarItem();
		try {
			assert.match(items[0].text, /1 ACP routes/);
			assert.match(String(items[0].tooltip), /Pinned specialists \(2\)/);
			assert.match(String(items[0].tooltip), /@anton-code → claude-acp: adapter missing/);
		} finally { harness.dispose(); }
	});
});
