/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { AgentManager } from 'son-of-anton-core/agents/AgentManager';
import { MetricsTracker } from 'son-of-anton-core/agents/MetricsTracker';
import { BackgroundTaskClient, BackgroundTask } from '../background/BackgroundTaskClient';

/**
 * Agent fleet monitoring dashboard.
 * Shows all agent activity — foreground and background — with metrics,
 * task history, token spend, and alerts.
 */
export class FleetDashboardPanel {
	private static instance: FleetDashboardPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private readonly metricsTracker: MetricsTracker;
	private readonly backgroundClient: BackgroundTaskClient;
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;
	private updating = false;
	private initialized = false;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	private constructor(
		_extensionUri: vscode.Uri,
		_agentManager: AgentManager,
		metricsTracker: MetricsTracker,
		backgroundClient: BackgroundTaskClient,
	) {
		this.metricsTracker = metricsTracker;
		this.backgroundClient = backgroundClient;

		this.panel = vscode.window.createWebviewPanel(
			'sota.fleetDashboard',
			'Agent Fleet Dashboard',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		this.disposables.push(this.panel.onDidDispose(() => {
			FleetDashboardPanel.instance = undefined;
			this.stopRefresh();
			this.disposed = true;
			for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
		}));

		this.disposables.push(this.panel.webview.onDidReceiveMessage(async message => {
			switch (message.command) {
				case 'refresh':
					await this.updateDashboard();
					break;
				case 'cancelTask':
					if (!await this.backgroundClient.cancelTask(message.taskId)) { void vscode.window.showErrorMessage(vscode.l10n.t('Could not cancel the background task. Refresh its status and try again.')); }
					await this.updateDashboard();
					break;
				case 'viewResults':
					vscode.commands.executeCommand('sota.showBackgroundTaskResults', message.taskId);
					break;
			}
		}));

		void this.updateDashboard();
		this.startRefresh();
	}

	static createOrShow(
		extensionUri: vscode.Uri,
		agentManager: AgentManager,
		metricsTracker: MetricsTracker,
		backgroundClient: BackgroundTaskClient,
	): FleetDashboardPanel {
		if (FleetDashboardPanel.instance) {
			FleetDashboardPanel.instance.panel.reveal();
			return FleetDashboardPanel.instance;
		}

		FleetDashboardPanel.instance = new FleetDashboardPanel(
			extensionUri, agentManager, metricsTracker, backgroundClient
		);
		return FleetDashboardPanel.instance;
	}

	private startRefresh(): void {
		this.refreshTimer = setInterval(() => {
			this.updateDashboard();
		}, 10000);
	}

	private stopRefresh(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	private async updateDashboard(): Promise<void> {
		if (this.disposed || this.updating) { return; }
		this.updating = true;
		try {
			const [backgroundTasks, foregroundMetrics] = await Promise.all([
				this.backgroundClient.listTasks(),
				Promise.resolve(this.metricsTracker.getAllMetrics()),
			]);

			const activeTasks = backgroundTasks.filter(
				t => t.status === 'running' || t.status === 'pending'
			);
			const completedTasks = backgroundTasks.filter(
				t => t.status !== 'running' && t.status !== 'pending'
			);

			const alerts = this.generateAlerts(backgroundTasks, foregroundMetrics);
			if (this.backgroundClient.lastListError) { alerts.unshift({ type: 'error', message: vscode.l10n.t('Background service unavailable. Task counts are incomplete. {0}', this.backgroundClient.lastListError) }); }

			if (this.disposed) { return; }
			const html = this.buildHtml(
				activeTasks,
				completedTasks,
				foregroundMetrics,
				alerts,
			);
			if (!this.initialized) {
				this.panel.webview.html = html;
				this.initialized = true;
			} else {
				await this.panel.webview.postMessage({ type: 'dashboardUpdate', html });
			}
		} finally {
			this.updating = false;
		}
	}

	private generateAlerts(
		tasks: BackgroundTask[],
		_metrics: ReturnType<MetricsTracker['getAllMetrics']>,
	): Alert[] {
		const alerts: Alert[] = [];

		for (const task of tasks) {
			if (task.status === 'failed' && task.error) {
				alerts.push({
					type: 'error',
					message: `Task "${task.name}" failed: ${task.error}`,
					taskId: task.id,
				});
			}
			if (task.status === 'timeout') {
				alerts.push({
					type: 'warning',
					message: `Task "${task.name}" timed out after ${formatDuration(task.resourceLimits.timeoutMs)}`,
					taskId: task.id,
				});
			}
			if (task.tokenUsage.estimatedCostUsd >= task.resourceLimits.maxTokenBudgetUsd * 0.9) {
				alerts.push({
					type: 'warning',
					message: `Task "${task.name}" approaching token budget ($${task.tokenUsage.estimatedCostUsd.toFixed(2)} / $${task.resourceLimits.maxTokenBudgetUsd})`,
					taskId: task.id,
				});
			}
		}

		return alerts;
	}

	private buildHtml(
		activeTasks: BackgroundTask[],
		completedTasks: BackgroundTask[],
		metrics: ReturnType<MetricsTracker['getAllMetrics']>,
		alerts: Alert[],
	): string {
		const totalTokens = metrics.reduce((sum, m) => sum + m.totalInputTokens + m.totalOutputTokens, 0);
		const totalInvocations = metrics.reduce((sum, m) => sum + m.totalInvocations, 0);
		const avgSuccessRate = metrics.length > 0
			? metrics.reduce((sum, m) =>
				sum + (m.totalInvocations > 0 ? m.firstPassSuccessCount / m.totalInvocations : 0), 0
			) / metrics.length * 100
			: 0;

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Agent Fleet Dashboard</title>
	<style>
		body {
			font-family: var(--vscode-font-family, sans-serif);
			color: var(--vscode-foreground);
			background-color: var(--vscode-editor-background);
			padding: 16px;
			margin: 0;
		}
		h1 { font-size: 1.4em; margin-bottom: 16px; }
		h2 { font-size: 1.1em; margin: 16px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
		* { box-sizing: border-box; }
		.table-scroll { width: 100%; overflow-x: auto; overscroll-behavior: contain; }
		.table-scroll table { min-width: 520px; }
		:where(button, .table-scroll):focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
		.alert { overflow-wrap: anywhere; }
		.metrics-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(min(180px, 100%), 1fr));
			gap: 12px;
			margin-bottom: 16px;
		}
		.metric-card {
			background: var(--vscode-editor-inactiveSelectionBackground);
			border-radius: 6px;
			padding: 12px;
			text-align: center;
		}
		.metric-value { font-size: 1.8em; font-weight: bold; color: var(--vscode-textLink-foreground); }
		.metric-label { font-size: 0.85em; opacity: 0.7; margin-top: 4px; }
		.alert {
			padding: 8px 12px;
			border-radius: 4px;
			margin-bottom: 6px;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.alert-error { background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
		.alert-warning { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 0.9em;
		}
		th, td {
			padding: 6px 10px;
			text-align: left;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		th { font-weight: 600; opacity: 0.8; }
		.status-badge {
			display: inline-block;
			padding: 2px 8px;
			border-radius: 10px;
			font-size: 0.8em;
			font-weight: 600;
		}
		.status-running { background: var(--vscode-charts-blue); color: white; }
		.status-completed { background: var(--vscode-charts-green); color: white; }
		.status-failed { background: var(--vscode-charts-red); color: white; }
		.status-pending { background: var(--vscode-charts-yellow); color: black; }
		.status-cancelled, .status-timeout { background: var(--vscode-charts-orange); color: white; }
		.progress-bar {
			width: 100%;
			height: 6px;
			background: var(--vscode-progressBar-background);
			border-radius: 3px;
			overflow: hidden;
		}
		.progress-fill {
			height: 100%;
			background: var(--vscode-textLink-foreground);
			transition: width 0.3s ease;
		}
		button {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 4px 12px;
			border-radius: 4px;
			cursor: pointer;
			font-size: 0.85em;
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		.btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
		.empty { opacity: 0.6; font-style: italic; padding: 12px; }
	</style>
</head>
<body>
<main id="dashboardContent">
	<h1>Agent Fleet Dashboard</h1>

	${alerts.length > 0 ? `
	<div class="alerts">
		${alerts.map(a => `
			<div class="alert alert-${a.type}">
				<span>${a.type === 'error' ? '&#x26D4;' : '&#x26A0;'}</span>
				<span>${escapeHtml(a.message)}</span>
			</div>
		`).join('')}
	</div>` : ''}

	<div class="metrics-grid">
		<div class="metric-card">
			<div class="metric-value">${activeTasks.length}</div>
			<div class="metric-label">Active Agents</div>
		</div>
		<div class="metric-card">
			<div class="metric-value">${totalInvocations}</div>
			<div class="metric-label">Total Invocations</div>
		</div>
		<div class="metric-card">
			<div class="metric-value">${avgSuccessRate.toFixed(1)}%</div>
			<div class="metric-label">Success Rate</div>
		</div>
		<div class="metric-card">
			<div class="metric-value">${formatTokenCount(totalTokens)}</div>
			<div class="metric-label">Total Tokens</div>
		</div>
	</div>

	<h2>Active Tasks</h2>
	${activeTasks.length === 0 ? '<p class="empty">No active tasks</p>' : `
	<div class="table-scroll" role="region" aria-label="${vscode.l10n.t('Active Tasks')}" tabindex="0"><table>
		<thead><tr><th>Name</th><th>Status</th><th>Progress</th><th>Duration</th><th>Actions</th></tr></thead>
		<tbody>
		${activeTasks.map(t => `
			<tr>
				<td>${escapeHtml(t.name)}</td>
				<td><span class="status-badge status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
				<td>
					<div class="progress-bar"><div class="progress-fill" style="width:${t.progress.percentage}%"></div></div>
					<small>${escapeHtml(t.progress.message)}</small>
				</td>
				<td>${t.startedAt ? formatDuration(Date.now() - t.startedAt) : '-'}</td>
				<td><button data-action="cancel" data-taskid="${escapeHtml(t.id)}">Cancel</button></td>
			</tr>
		`).join('')}
		</tbody>
	</table></div>`}

	<h2>Completed Tasks</h2>
	${completedTasks.length === 0 ? '<p class="empty">No completed tasks</p>' : `
	<div class="table-scroll" role="region" aria-label="${vscode.l10n.t('Completed Tasks')}" tabindex="0"><table>
		<thead><tr><th>Name</th><th>Status</th><th>Duration</th><th>Cost</th><th>Actions</th></tr></thead>
		<tbody>
		${completedTasks.slice(0, 20).map(t => `
			<tr>
				<td>${escapeHtml(t.name)}</td>
				<td><span class="status-badge status-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td>
				<td>${t.startedAt && t.completedAt ? formatDuration(t.completedAt - t.startedAt) : '-'}</td>
				<td>$${t.tokenUsage.estimatedCostUsd.toFixed(2)}</td>
				<td><button class="btn-secondary" data-action="results" data-taskid="${escapeHtml(t.id)}">Results</button></td>
			</tr>
		`).join('')}
		</tbody>
	</table></div>`}

	<h2>Agent Metrics</h2>
	${metrics.length === 0 ? '<p class="empty">No agent metrics recorded yet</p>' : `
	<div class="table-scroll" role="region" aria-label="${vscode.l10n.t('Agent Metrics')}" tabindex="0"><table>
		<thead><tr><th>Agent</th><th>Invocations</th><th>Success Rate</th><th>Avg Retries</th><th>Avg Latency</th></tr></thead>
		<tbody>
		${metrics.map(m => `
			<tr>
				<td>${escapeHtml(m.agentHandle)}</td>
				<td>${m.totalInvocations}</td>
				<td>${m.totalInvocations > 0 ? (m.firstPassSuccessCount / m.totalInvocations * 100).toFixed(1) : 'N/A'}%</td>
				<td>${m.totalInvocations > 0 ? (m.totalRetries / m.totalInvocations).toFixed(2) : '0'}</td>
				<td>${Math.round(m.averageLatencyMs)}ms</td>
			</tr>
		`).join('')}
		</tbody>
	</table></div>`}

	<div style="margin-top: 16px; text-align: right;">
		<button data-action="refresh">Refresh</button>
	</div>

</main>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		window.addEventListener('message', ({ data }) => {
			if (data.type !== 'dashboardUpdate' || typeof data.html !== 'string') { return; }
			const next = new DOMParser().parseFromString(data.html, 'text/html').getElementById('dashboardContent');
			if (!next) { return; }
			const content = document.getElementById('dashboardContent');
			const active = document.activeElement;
			const focusKey = active?.dataset.action;
			const taskId = active?.dataset.taskid;
			const regionLabel = active?.getAttribute('aria-label');
			const scroll = [...content.querySelectorAll('.table-scroll')].map(region => region.scrollLeft);
			const top = window.scrollY;
			content.replaceChildren(...next.childNodes);
			const target = [...content.querySelectorAll('[data-action], .table-scroll')].find(element =>
				focusKey ? element.dataset.action === focusKey && element.dataset.taskid === taskId : regionLabel && element.getAttribute('aria-label') === regionLabel);
			target?.focus({ preventScroll: true });
			content.querySelectorAll('.table-scroll').forEach((region, index) => { region.scrollLeft = scroll[index] || 0; });
			window.scrollTo(0, top);
		});
		// Strict CSP blocks inline handlers; delegate clicks from data-action buttons.
		document.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-action]');
			if (!btn) { return; }
			switch (btn.dataset.action) {
				case 'refresh': vscode.postMessage({ command: 'refresh' }); break;
				case 'cancel': vscode.postMessage({ command: 'cancelTask', taskId: btn.dataset.taskid }); break;
				case 'results': vscode.postMessage({ command: 'viewResults', taskId: btn.dataset.taskid }); break;
			}
		});
	</script>
</body>
</html>`;
	}
}

interface Alert {
	type: 'error' | 'warning';
	message: string;
	taskId?: string;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Cryptographically-random nonce for the webview's Content-Security-Policy. */
function getNonce(): string {
	return randomBytes(16).toString('hex');
}

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	if (ms < 3600000) {
		return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
	}
	return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function formatTokenCount(count: number): string {
	if (count < 1000) {
		return String(count);
	}
	if (count < 1000000) {
		return `${(count / 1000).toFixed(1)}K`;
	}
	return `${(count / 1000000).toFixed(1)}M`;
}
