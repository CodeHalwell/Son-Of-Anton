/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { AcpRegistry, type RegistryPlan } from 'son-of-anton-core/integrations/AcpRegistry';
import type { AcpAgentDefinition } from 'son-of-anton-core/acp/protocol';
import { registerAcpRegistryCommands } from '../src/integrations/AcpRegistryCommands';

suite('Claude ACP setup', () => {
	const original = { register: vscode.commands.registerCommand, configuration: vscode.workspace.getConfiguration, warning: vscode.window.showWarningMessage, information: vscode.window.showInformationMessage, progress: vscode.window.withProgress, plan: AcpRegistry.prototype.plan };
	let registration: vscode.Disposable;
	let configure: () => Promise<boolean>;
	let agents: AcpAgentDefinition[];
	let updates: { key: string; target?: vscode.ConfigurationTarget | boolean | null }[];
	const launch: AcpAgentDefinition = { id: 'claude-acp', command: 'npx', args: ['--yes', '@agentclientprotocol/claude-agent-acp@0.75.1'] };
	const plan: RegistryPlan = { kind: 'npx', package: '@agentclientprotocol/claude-agent-acp@0.75.1', launch, agent: { id: 'claude-acp', name: 'Claude', version: '0.75.1', distribution: {} } };
	setup(() => {
		agents = []; updates = [];
		vscode.commands.registerCommand = (command: string, callback: () => Promise<boolean>) => { if (command === 'sota.configureClaudeAcp') { configure = callback; } return { dispose() {} }; };
		vscode.workspace.getConfiguration = (() => ({ has: () => true, inspect: () => undefined, get: () => agents, update: async (key: string, value: AcpAgentDefinition[], target?: vscode.ConfigurationTarget | boolean | null) => { agents = value; updates.push({ key, target }); } })) as typeof vscode.workspace.getConfiguration;
		vscode.window.withProgress = ((_options, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) })) as typeof vscode.window.withProgress;
		vscode.window.showInformationMessage = async () => undefined;
		AcpRegistry.prototype.plan = async () => plan;
		registration = registerAcpRegistryCommands();
	});
	teardown(() => {
		registration?.dispose();
		vscode.commands.registerCommand = original.register;
		vscode.workspace.getConfiguration = original.configuration;
		vscode.window.showWarningMessage = original.warning;
		vscode.window.showInformationMessage = original.information;
		vscode.window.withProgress = original.progress;
		AcpRegistry.prototype.plan = original.plan;
	});

	test('cancel leaves provider setup incomplete and settings untouched', async () => {
		vscode.window.showWarningMessage = async () => undefined;
		assert.deepEqual({ configured: await configure(), agents, updates }, { configured: false, agents: [], updates: [] });
	});

	test('confirmation preserves adapters added while the modal was open', async () => {
		const other = { id: 'other', command: 'other-acp' };
		vscode.window.showWarningMessage = (async (_message: string, options: vscode.MessageOptions, action: vscode.MessageItem) => {
			assert.match(options.detail ?? '', /Specialists.*Claude Code.*Tool approvals remain enabled/s);
			agents.push(other);
			return action;
		}) as typeof vscode.window.showWarningMessage;
		assert.deepEqual({ configured: await configure(), agents, updates }, { configured: true, agents: [other, launch], updates: [{ key: 'acp.agents', target: vscode.ConfigurationTarget.Global }] });
	});

	test('existing custom launch is preserved without downloading or prompting', async () => {
		agents = [{ id: 'claude-acp', command: '/custom/claude-acp', env: { CUSTOM: 'keep' } }];
		AcpRegistry.prototype.plan = async () => { throw new Error('Must not fetch the registry'); };
		vscode.window.showWarningMessage = async () => { throw new Error('Must not replace existing adapter'); };
		assert.equal(await configure(), true);
		assert.deepEqual(updates, []);
	});
});
