/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpRegistry } from 'son-of-anton-core/integrations/AcpRegistry';
import type { AcpAgentDefinition } from 'son-of-anton-core/acp/protocol';

/** Metadata browsing and explicit configuration are distinct from adapter execution. */
export function registerAcpRegistryCommands(): vscode.Disposable {
	return vscode.commands.registerCommand('sota.browseAcpAdapters', async () => {
		try {
			const registry = new AcpRegistry(join(homedir(), '.son-of-anton', 'acp-registry'));
			const catalog = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading ACP Adapter Registry…') }, () => registry.catalog());
			const picked = await vscode.window.showQuickPick([{ label: vscode.l10n.t('Refresh Registry'), id: '', description: vscode.l10n.t('Fetch the latest adapter metadata') }, ...catalog.agents.map(agent => ({ label: agent.name, id: agent.id, description: agent.version, detail: agent.description }))], { title: vscode.l10n.t('ACP Adapters'), matchOnDescription: true, matchOnDetail: true });
			if (!picked) { return; }
			if (!picked.id) { await registry.catalog(true); await vscode.commands.executeCommand('sota.browseAcpAdapters'); return; }
			const plan = await registry.plan(picked.id);
			const config = vscode.workspace.getConfiguration('sota'); const current = config.get<AcpAgentDefinition[]>('acp.agents', []);
			const action = plan.kind === 'binary' ? vscode.l10n.t('Install and Configure') : vscode.l10n.t('Configure Adapter');
			const detail = plan.kind === 'binary'
				? vscode.l10n.t('Download {0}\nSHA-256: {1}\nThe adapter will not run until you select it for an agent.', plan.archive!, plan.sha256!)
				: vscode.l10n.t('Pinned package: {0}\nCommand: {1}\nThe package runner downloads and executes this version on first use. Discovery itself does not run the adapter.', plan.package!, JSON.stringify([plan.launch!.command, ...plan.launch!.args ?? []]));
			if (await vscode.window.showWarningMessage(vscode.l10n.t('{0} {1}', plan.agent.name, plan.agent.version), { modal: true, detail: detail + (current.some(agent => agent.id === picked.id) ? '\n' + vscode.l10n.t('This replaces the existing adapter configuration with the same ID.') : '') }, action) !== action) { return; }
			const launch = plan.launch ?? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Installing Verified ACP Adapter…') }, () => registry.installBinary(picked.id));
			await config.update('acp.agents', [...current.filter(agent => agent.id !== launch.id), launch], vscode.ConfigurationTarget.Global);
			await vscode.window.showInformationMessage(vscode.l10n.t('Configured {0}. Select its ID in agent routing or a Council group, then reload the window. Council also requires the adapter’s advertised read-only mode.', launch.id));
		} catch (error) { await vscode.window.showErrorMessage(vscode.l10n.t('ACP Adapter: {0}', error instanceof Error ? error.message : String(error))); }
	});
}
