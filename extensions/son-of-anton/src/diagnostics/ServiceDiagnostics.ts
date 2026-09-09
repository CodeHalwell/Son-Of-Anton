/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { CodeGraphBackend } from '../codeGraph/CodeGraphBackend';
import type { BackgroundTaskClient } from '../background/BackgroundTaskClient';
import type { HealthMonitor, HealthStatus } from '../monitoring/HealthMonitor';

interface DiagnosticAction { label: string; command: string; args?: string[] }
export interface ServiceDiagnostic { id: string; label: string; status: HealthStatus; detail: string; checkedAt: number | undefined; actions: DiagnosticAction[] }
export interface ServiceDiagnosticsOptions {
	graph: () => CodeGraphBackend | undefined;
	mcpStates: ReadonlyMap<string, string>;
	background?: BackgroundTaskClient;
	health?: HealthMonitor;
	reconcileMcp: () => void;
}
const settings = (query: string): DiagnosticAction => ({ label: vscode.l10n.t('Open Settings'), command: 'workbench.action.openSettings', args: [query] });

/** Cached or absent observations are never represented as a successful live health check. */
export function diagnosticOverall(services: Pick<ServiceDiagnostic, 'status' | 'checkedAt'>[], now = Date.now()): HealthStatus {
	if (!services.length) { return 'unknown'; }
	if (services.some(service => service.status === 'unhealthy')) { return 'unhealthy'; }
	if (services.some(service => service.status === 'degraded')) { return 'degraded'; }
	if (services.some(service => service.status === 'unknown' || !service.checkedAt || now - service.checkedAt > 120_000)) { return 'unknown'; }
	return 'healthy';
}

export function registerServiceDiagnostics(context: vscode.ExtensionContext, options: ServiceDiagnosticsOptions): void {
	const output = vscode.window.createOutputChannel(vscode.l10n.t('Son of Anton Service Diagnostics'));
	context.subscriptions.push(output);
	let disposed = false;
	context.subscriptions.push({ dispose: () => { disposed = true; } });
	const snapshot = async (): Promise<ServiceDiagnostic[]> => {
		const now = Date.now(), graph = options.graph(), services: ServiceDiagnostic[] = [];
		services.push({ id: 'workspace', label: vscode.l10n.t('Workspace Trust'), status: vscode.workspace.isTrusted ? 'healthy' : 'unknown', checkedAt: now,
			detail: vscode.workspace.isTrusted ? vscode.l10n.t('Trusted. Individual MCP and tool approvals remain active.') : vscode.l10n.t('Restricted Mode: agent execution and MCP processes are paused.'), actions: [{ label: vscode.l10n.t('Manage Workspace Trust'), command: 'workbench.trust.manage' }] });
		const state = graph?.currentState;
		services.push({ id: 'code-graph', label: vscode.l10n.t('Code Graph'), checkedAt: now,
			status: state === 'failed' ? 'unhealthy' : state === 'starting' ? 'degraded' : state === 'embedded' || state === 'docker' ? 'healthy' : 'unknown',
			detail: graph ? `${graph.failureReason ?? state} · ${vscode.l10n.t('Semantic search: {0}', graph.semanticState)} · ${graph.lastIndexedAt ? vscode.l10n.t('Last indexed: {0}', new Date(graph.lastIndexedAt).toLocaleString()) : vscode.l10n.t('No completed index reported')}` : vscode.l10n.t('Backend has not initialized.'),
			actions: [{ label: vscode.l10n.t('Show Logs'), command: 'sota.codeGraph.openLogs' }, { label: vscode.l10n.t('Restart Code Graph'), command: 'sota.codeGraph.restart' }, { label: vscode.l10n.t('Reindex Workspace'), command: 'sota.codeGraph.indexWorkspace' }, settings('sota.codeGraph')] });
		const configured = vscode.workspace.getConfiguration('sota').get<{ name?: string }[]>('mcp.servers', []);
		const names = new Set([...options.mcpStates.keys(), ...(Array.isArray(configured) ? configured.filter(server => typeof server?.name === 'string').map(server => server.name!) : [])]);
		for (const name of names) {
			const state = options.mcpStates.get(name);
			services.push({ id: `mcp:${name}`, label: `MCP · ${name}`, status: state === 'connected' || state === 'ready' ? 'healthy' : state === 'error' || state === 'failed' ? 'unhealthy' : state === 'connecting' ? 'degraded' : 'unknown', checkedAt: now,
				detail: vscode.l10n.t('Current connection state: {0}. Tool invocation health is checked when a tool runs.', state ?? 'not observed'),
				actions: [{ label: vscode.l10n.t('Retry MCP Connections'), command: 'sota.retryMcpConnections' }, settings('sota.mcp')] });
		}
		if (!names.size) { services.push({ id: 'mcp', label: 'MCP', status: 'unknown', checkedAt: now, detail: vscode.l10n.t('No MCP connection has been observed.'), actions: [{ label: vscode.l10n.t('Manage Integration Profiles'), command: 'sota.manageIntegrationProfiles' }, settings('sota.mcp')] }); }
		services.push({ id: 'acp', label: vscode.l10n.t('ACP Agents'), status: 'unknown', checkedAt: undefined, detail: vscode.l10n.t('Run diagnostics to verify configured adapters and their handshake. This explicitly launches the configured adapters in a trusted workspace.'), actions: [{ label: vscode.l10n.t('Diagnose ACP Agents'), command: 'sota.diagnoseAcpAgents' }, settings('sota.acp')] });
		if (options.background) {
			const tasks = await options.background.listTasks('active');
			services.push({ id: 'background', label: vscode.l10n.t('Background Tasks'), status: options.background.lastListError ? 'unhealthy' : 'healthy', checkedAt: Date.now(),
				detail: options.background.lastListError ?? vscode.l10n.t('{0} active tasks. The task service responded successfully.', tasks.length), actions: [{ label: vscode.l10n.t('Retry Health Check'), command: 'sota.serviceDiagnostics' }, settings('sota.background')] });
		}
		for (const component of options.health?.getSystemHealth().components ?? []) {
			if (component.component === 'code-graph') { continue; }
			services.push({ id: component.component, label: component.component, status: now - component.lastChecked > 120_000 ? 'unknown' : component.status, checkedAt: component.lastChecked,
				detail: component.details || vscode.l10n.t('No details recorded.'), actions: [] });
		}
		return services;
	};
	context.subscriptions.push(vscode.commands.registerCommand('sota.retryMcpConnections', () => { if (vscode.workspace.isTrusted) { options.reconcileMcp(); } else { void vscode.window.showInformationMessage(vscode.l10n.t('Trust the workspace before reconnecting MCP servers.')); } }));
	context.subscriptions.push(vscode.commands.registerCommand('sota.serviceDiagnostics', async () => {
		try {
			const services = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Checking Backend Services') }, snapshot);
			if (disposed) { return; }
			output.clear();
			output.appendLine(vscode.l10n.t('Overall: {0}. Checked at {1}.', diagnosticOverall(services), new Date().toLocaleString()));
			for (const service of services) { output.appendLine(`[${service.status}] ${service.label}\n${service.detail}\n${vscode.l10n.t('Observed: {0}', service.checkedAt ? new Date(service.checkedAt).toLocaleString() : 'not checked')}\n`); }
			const pick = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('Open Full Diagnostic Report'), description: '', detail: '', service: undefined },
				...services.map(service => ({ label: service.label, description: service.status, detail: service.detail, service })),
			], { title: vscode.l10n.t('Service Diagnostics'), matchOnDescription: true, matchOnDetail: true });
			if (!pick || disposed) { return; }
			if (!pick.service) { output.show(); return; }
			if (!pick.service.actions.length) { output.show(); return; }
			const action = await vscode.window.showQuickPick(pick.service.actions, { title: pick.service.label, placeHolder: pick.service.detail });
			if (action && !disposed) { await vscode.commands.executeCommand(action.command, ...(action.args ?? [])); }
		} catch (error) { if (!disposed) { await vscode.window.showErrorMessage(vscode.l10n.t('Service diagnostics failed: {0}', error instanceof Error ? error.message : String(error))); } }
	}));
}
