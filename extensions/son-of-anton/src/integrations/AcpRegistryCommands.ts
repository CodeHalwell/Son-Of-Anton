/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpRegistry, type RegistryPlan } from 'son-of-anton-core/integrations/AcpRegistry';
import type { AcpAgentDefinition } from 'son-of-anton-core/acp/protocol';

/** Metadata browsing and explicit configuration are distinct from adapter execution. */
export function registerAcpRegistryCommands(): vscode.Disposable {
	const browse = vscode.commands.registerCommand('sota.browseAcpAdapters', async () => {
		try {
			const registry = new AcpRegistry(join(homedir(), '.son-of-anton', 'acp-registry'));
			const catalog = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading ACP Adapter Registry…') }, () => registry.catalog());
			const picked = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Refresh Registry'), id: '', description: vscode.l10n.t('Fetch the latest adapter metadata') }, ...catalog.agents.map(agent => ({ label: agent.name, id: agent.id, description: agent.version, detail: agent.description }))], { title: vscode.l10n.t('ACP Adapters'), matchOnDescription: true, matchOnDetail: true });
			if (!picked) { return; }
			if (!picked.id) { await registry.catalog(true); await vscode.commands.executeCommand('sota.browseAcpAdapters'); return; }
			const plan = await registry.plan(picked.id);
			await configureAdapter(registry, plan);
		} catch (error) { await vscode.window.showErrorMessage(vscode.l10n.t('ACP Adapter: {0}', error instanceof Error ? error.message : String(error))); }
	});
	const claude = vscode.commands.registerCommand('sota.configureClaudeAcp', async (): Promise<boolean> => {
		try {
			const current = vscode.workspace.getConfiguration('sota').get<AcpAgentDefinition[]>('acp.agents', []);
			if (current.some(agent => agent.id === 'claude-acp' && agent.command?.trim())) { return true; }
			const registry = new AcpRegistry(join(homedir(), '.son-of-anton', 'acp-registry'));
			const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Preparing Claude ACP…') }, () => registry.plan('claude-acp'));
			return await configureAdapter(registry, plan);
		} catch (error) { await vscode.window.showErrorMessage(vscode.l10n.t('Claude ACP: {0}', error instanceof Error ? error.message : String(error))); return false; }
	});
	return vscode.Disposable.from(browse, claude);
}

async function configureAdapter(registry: AcpRegistry, plan: RegistryPlan): Promise<boolean> {
	const config = vscode.workspace.getConfiguration('sota');
	const current = config.get<AcpAgentDefinition[]>('acp.agents', []);
	const action = plan.kind === 'binary' ? vscode.l10n.t('Install and Configure') : vscode.l10n.t('Configure Adapter');
	const detail = plan.kind === 'binary'
		? vscode.l10n.t('Download {0}\nSHA-256: {1}', plan.archive!, plan.sha256!)
		: vscode.l10n.t('Pinned package: {0}\nCommand: {1}\nThe package runner downloads and executes this version on first use.', plan.package!, JSON.stringify([plan.launch!.command, ...plan.launch!.args ?? []]));
	const routing = plan.agent.id === 'claude-acp'
		? vscode.l10n.t('Specialists using a “via Claude Code” model will use this adapter with your existing Claude sign-in. Tool approvals remain enabled.')
		: vscode.l10n.t('The adapter will not run until you select it for an agent.');
	if (await vscode.window.showWarningMessage(vscode.l10n.t('{0} {1}', plan.agent.name, plan.agent.version), { modal: true, detail: `${detail}\n${routing}` + (current.some(agent => agent.id === plan.agent.id) ? '\n' + vscode.l10n.t('This replaces the existing adapter configuration with the same ID.') : '') }, action) !== action) { return false; }
	const launch = plan.launch ?? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing Verified ACP Adapter…') }, () => registry.installBinary(plan.agent.id));
	// Re-read after the modal/download so unrelated concurrent configuration changes survive.
	const latest = config.get<AcpAgentDefinition[]>('acp.agents', []);
	await config.update('acp.agents', [...latest.filter(agent => agent.id !== launch.id), launch], vscode.ConfigurationTarget.Global);
	await vscode.window.showInformationMessage(launch.id === 'claude-acp'
		? vscode.l10n.t('Claude ACP is configured. Retry the task; no window reload is required.')
		: vscode.l10n.t('Configured {0}. Select its ID in agent routing or a Council group. Council also requires the adapter’s advertised read-only mode.', launch.id));
	return true;
}
