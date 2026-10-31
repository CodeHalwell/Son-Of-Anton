/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { daemonSetupCallbacks, daemonProviderCredentialState, onDidChangeDaemonProviderCredentials, openDaemonModelSetup, saveDaemonProviderCredentials } from '../src/daemon/DaemonProviderSetup';
import { SetupWizardPanel, type SetupWizardDeps } from '../src/onboarding/SetupWizardPanel';
import { ChatSession } from '../src/chat/ChatPanel';

suite('Private runtime provider setup', () => {
	const commands = vscode.commands;
	let restore: () => void;
	const calls: Array<{ command: string; arguments: readonly unknown[] }> = [];
	let reply: object | undefined;
	setup(() => {
		calls.length = 0;
		const original = commands.executeCommand;
		Object.assign(commands, { executeCommand: async (command: string, ...args: unknown[]) => { calls.push({ command, arguments: args }); return reply; } });
		restore = () => Object.assign(commands, { executeCommand: original });
	});
	teardown(() => restore());

	test('opens the local setup wizard and keeps external model configuration with its owner', async () => {
		reply = { mode: 'local', socketPath: '/fixture/anton.sock', identity: 'anton' };
		await openDaemonModelSetup();
		assert.deepEqual(calls.map(call => call.command), ['sota.daemon.endpoint', 'sota.openSetupWizard']);
		calls.length = 0;
		reply = { mode: 'external', socketPath: '/fixture/external.sock', identity: 'external' };
		const original = vscode.window.showInformationMessage;
		const notices: string[] = [];
		Object.assign(vscode.window, { showInformationMessage: async (message: string) => { notices.push(message); return undefined; } });
		try {
			await openDaemonModelSetup();
			assert.deepEqual(calls.map(call => call.command), ['sota.daemon.endpoint']);
			assert.match(notices[0], /application that owns the attached runtime/);
		} finally { Object.assign(vscode.window, { showInformationMessage: original }); }
	});

	test('successful wizard and chat saves publish only the refresh state, while failed saves do not', async () => {
		const events: Array<{ restartPending: boolean }> = [];
		const listener = onDidChangeDaemonProviderCredentials(event => events.push(event));
		try {
			for (const code of ['saved', 'pending-restart', 'invalid']) {
				reply = { ok: code !== 'invalid', deferred: true, code };
				await saveDaemonProviderCredentials('openai', { apiKey: 'synthetic-private-key', model: 'selected-model' });
			}
			assert.deepEqual(events, [{ restartPending: false }, { restartPending: true }]);
		} finally { listener.dispose(); }
	});

	test('open chat refresh preserves its transcript and observes active work when restart is pending', async () => {
		for (const state of [
			{ restartPending: false, submitting: false, activeRuns: [], refresh: 'reconnect' },
			{ restartPending: true, submitting: false, activeRuns: [], refresh: 'probe' },
			{ restartPending: false, submitting: true, activeRuns: [], refresh: 'probe' },
			{ restartPending: false, submitting: false, activeRuns: ['started-after-save'], refresh: 'probe' },
		]) {
			const refreshed: string[] = [];
			const conversation = [{ role: 'user', content: 'Original history' }];
			const session = Object.assign(Object.create(ChatSession.prototype), {
				disposed: false, currentConversationId: 'original', conversation, daemonProviderRefreshSequence: 0,
				daemonChat: { snapshot: { projection: { activeRuns: state.activeRuns } }, isSubmitting: state.submitting, reconnect: async () => { refreshed.push('reconnect'); }, refreshModels: async () => { refreshed.push('probe'); } },
			}) as { refreshDaemonProviderModels(pending: boolean): Promise<void>; currentConversationId: string; conversation: typeof conversation };
			await session.refreshDaemonProviderModels(state.restartPending);
			assert.deepEqual({ refreshed, conversation: session.conversation, id: session.currentConversationId }, {
				refreshed: [state.refresh], conversation, id: 'original',
			});
		}
	});

	test('a superseded save refresh cannot publish a stale reconnect error after a newer refresh succeeds', async () => {
		const published: object[] = [];
		let rejectFirst!: (error: Error) => void;
		const firstReconnect = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
		let reconnects = 0;
		const session = Object.assign(Object.create(ChatSession.prototype), {
			disposed: false, currentConversationId: 'original', daemonProviderRefreshSequence: 0,
			daemonChat: { snapshot: { projection: { activeRuns: [] } }, isSubmitting: false, reconnect: () => ++reconnects === 1 ? firstReconnect : Promise.resolve() },
			webview: { postMessage: (message: object) => { published.push(message); return Promise.resolve(true); } },
		}) as { refreshDaemonProviderModels(pending: boolean): Promise<void> };
		const first = session.refreshDaemonProviderModels(false);
		await session.refreshDaemonProviderModels(false);
		rejectFirst(new Error('This connection was superseded.')); await first;
		assert.deepEqual(published, []);
	});

	test('routes setup through one write-only command and displays only a localized result code', async () => {
		reply = { ok: true, deferred: true, code: 'saved', message: 'must not display process output' };
		const fields = { apiKey: 'synthetic-private-key', model: 'selected-model' };
		const result = await saveDaemonProviderCredentials('openai', fields);
		assert.deepEqual(calls, [{ command: 'sota.daemon.configureProvider', arguments: [{ provider: 'openai', fields }] }]);
		assert.equal(result.ok, true);
		assert.match(result.message, /Inference has not been tested/);
		assert.doesNotMatch(JSON.stringify(result), /synthetic-private-key|process output/);
	});

	test('requires both local model metadata and protected-key presence for a configured badge', async () => {
		reply = { mode: 'local', anthropic: { hasApiKey: true, model: 'haiku' }, openai: { hasApiKey: true }, google: { hasApiKey: false, model: 'flash' } };
		const state = await daemonProviderCredentialState();
		assert.deepEqual([state.anthropic.hasApiKey, state.openai.hasApiKey, state.google.hasApiKey], [true, false, false]);
		assert.deepEqual(state.runtimeModels, { anthropic: 'haiku', google: 'flash' });
		assert.equal(calls[0].command, 'sota.daemon.providerStatus');
		reply = { mode: 'external', anthropic: { hasApiKey: true, model: 'haiku' } };
		const external = await daemonProviderCredentialState();
		assert.equal(external.anthropic.hasApiKey, false);
		assert.deepEqual(external.runtimeModels, {});
	});

	test('does not pass command exception contents to the setup panel', async () => {
		Object.assign(commands, { executeCommand: async () => { throw new Error('synthetic-secret from failed child'); } });
		const result = await saveDaemonProviderCredentials('openai', { apiKey: 'synthetic-secret' });
		assert.equal(result.ok, false);
		assert.doesNotMatch(result.message, /synthetic-secret|failed child/);
	});

	test('reuses panel callbacks without calling the native model client', async () => {
		reply = { ok: true, code: 'saved', deferred: true };
		const published: object[] = [];
		const callbacks = daemonSetupCallbacks();
		const deps = { ...callbacks, readCredentialState: async () => ({}) } as unknown as SetupWizardDeps;
		const wizard = Object.assign(Object.create(SetupWizardPanel.prototype), { deps, panel: { webview: { postMessage: (message: object) => published.push(message) } } }) as {
			handleSave(message: { provider: 'openai'; fields: Record<string, string> }): Promise<void>;
		};
		await wizard.handleSave({ provider: 'openai', fields: { apiKey: 'synthetic-private-key', model: 'selected-model' } });
		assert.equal(calls[0].command, 'sota.daemon.configureProvider');
		assert.deepEqual(published.map(message => (message as { type: string }).type), ['save-result', 'status']);
		assert.doesNotMatch(JSON.stringify(published), /synthetic-private-key/);
	});

	test('daemon panel fails closed if its save adapter was not supplied', async () => {
		const published: object[] = [];
		const deps = { runtime: 'daemon' } as SetupWizardDeps;
		const wizard = Object.assign(Object.create(SetupWizardPanel.prototype), { deps, panel: { webview: { postMessage: (message: object) => published.push(message) } } }) as {
			handleSave(message: { provider: 'openai'; fields: Record<string, string> }): Promise<void>;
		};
		await wizard.handleSave({ provider: 'openai', fields: { apiKey: 'synthetic-private-key' } });
		assert.equal(calls.length, 0);
		assert.deepEqual(published.map(message => ({ type: (message as { type: string }).type, ok: (message as { ok: boolean }).ok })), [{ type: 'save-result', ok: false }]);
	});
});
