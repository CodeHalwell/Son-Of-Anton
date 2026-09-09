/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ImpactAnalysisPanel — visual "blast radius" view for code changes.
 *
 * Shows what breaks if you change a function, class, or file.
 * Renders a graph visualization with color-coded nodes:
 * - Red: directly affected (direct callers, direct dependents)
 * - Amber: indirectly affected (transitive dependencies, depth 2+)
 * - Green: test files that cover the affected code
 * - Grey: documentation that references the affected code
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'crypto';

export interface ImpactNode {
	id: string;
	label: string;
	filePath: string;
	symbolName?: string;
	line?: number;
	type: 'direct' | 'transitive' | 'test' | 'documentation';
	depth: number;
	signature?: string;
}

export interface ImpactEdge {
	source: string;
	target: string;
	relationship: string;
}

export interface ImpactAnalysisData {
	/** Embedded graph returns file dependencies without caller depth or test coverage. */
	fileBased?: boolean;
	evidence?: string;
	truncated?: boolean;
	/** The symbol being analyzed */
	target: {
		name: string;
		filePath: string;
		signature?: string;
	};
	nodes: ImpactNode[];
	edges: ImpactEdge[];
	summary: {
		directCount: number;
		transitiveCount: number;
		testCount: number;
		documentationCount: number;
	};
}

export class ImpactAnalysisPanel {
	private static currentPanel: ImpactAnalysisPanel | undefined;
	private readonly panel: vscode.WebviewPanel;
	private navigation = new Map<string, { filePath: string; line?: number }>();
	private disposables: vscode.Disposable[] = [];

	private constructor(
		panel: vscode.WebviewPanel,
		_extensionUri: vscode.Uri,
	) {
		this.panel = panel;

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.webview.onDidReceiveMessage(
			message => this.handleMessage(message),
			null,
			this.disposables,
		);
	}

	/**
	 * Create or reveal the impact analysis panel.
	 */
	static createOrShow(extensionUri: vscode.Uri): ImpactAnalysisPanel {
		const column = vscode.ViewColumn.Beside;

		if (ImpactAnalysisPanel.currentPanel) {
			ImpactAnalysisPanel.currentPanel.panel.reveal(column);
			return ImpactAnalysisPanel.currentPanel;
		}

		const panel = vscode.window.createWebviewPanel(
			'sonOfAntonImpactAnalysis',
			'Impact Analysis',
			column,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri],
			},
		);

		ImpactAnalysisPanel.currentPanel = new ImpactAnalysisPanel(panel, extensionUri);
		return ImpactAnalysisPanel.currentPanel;
	}

	/**
	 * Update the panel with new impact analysis data.
	 */
	update(data: ImpactAnalysisData): void {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const generation = getNonce();
		const navigation = new Map<string, { filePath: string; line?: number }>();
		const navigationIds: Array<string | undefined> = [];
		const nodes = data.nodes.map((node, index) => {
			const filePath = path.isAbsolute(node.filePath) ? node.filePath : root ? path.resolve(root, node.filePath) : '';
			const navigationId = filePath ? `${generation}:${index}` : undefined;
			if (navigationId) {
				navigation.set(navigationId, { filePath, line: typeof node.line === 'number' && Number.isSafeInteger(node.line) && node.line > 0 ? node.line : undefined });
			}
			navigationIds.push(navigationId);
			return { ...node, filePath };
		});
		this.navigation = navigation;
		this.panel.webview.html = this.getHtml({ ...data, nodes }, navigationIds);
	}

	private handleMessage(message: unknown): void {
		if (!message || typeof message !== 'object') { return; }
		const request = message as { command?: unknown; navigationId?: unknown };
		if ('filePath' in request || 'line' in request) { return; }
		switch (request.command) {
			case 'navigateToFile':
				const target = typeof request.navigationId === 'string' ? this.navigation.get(request.navigationId) : undefined;
				if (target) {
					const uri = vscode.Uri.file(target.filePath);
					const options: vscode.TextDocumentShowOptions = {};
					if (target.line !== undefined) {
						options.selection = new vscode.Range(target.line - 1, 0, target.line - 1, 0);
					}
					vscode.window.showTextDocument(uri, options);
				}
				break;
		}
	}

	private getHtml(data: ImpactAnalysisData, navigationIds: readonly (string | undefined)[]): string {
		const nodeColors: Record<string, string> = {
			direct: '#e74c3c',       // Red
			transitive: '#f39c12',   // Amber
			test: '#2ecc71',         // Green
			documentation: '#95a5a6', // Grey
		};

		// Escape `<` so a value such as `</script>` in a symbol signature/label
		// cannot break out of the inline <script> element that embeds this JSON.
		// `<` round-trips back to `<` when the webview parses the literal.
		const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

		const nodesJson = embed(data.nodes.map((n, index) => ({
			id: n.id,
			label: n.label,
			color: nodeColors[n.type] ?? '#95a5a6',
			type: n.type,
			filePath: n.filePath,
			navigationId: navigationIds[index],
			symbolName: n.symbolName,
			signature: n.signature,
			depth: n.depth,
		})));

		const edgesJson = embed(data.edges.map(e => ({
			from: e.source,
			to: e.target,
			label: e.relationship,
		})));

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Impact Analysis</title>
	<style>
		body {
			margin: 0;
			padding: 0;
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
			background: var(--vscode-editor-background, #1e1e1e);
			color: var(--vscode-editor-foreground, #d4d4d4);
		}
		.header {
			padding: 12px 16px;
			border-bottom: 1px solid var(--vscode-panel-border, #333);
		}
		.header h2 {
			margin: 0 0 4px 0;
			font-size: 14px;
		}
		.header .target {
			font-size: 12px;
			opacity: 0.8;
		}
		.summary {
			display: flex;
			gap: 16px;
			padding: 8px 16px;
			font-size: 12px;
			border-bottom: 1px solid var(--vscode-panel-border, #333);
		}
		.summary-item {
			display: flex;
			align-items: center;
			gap: 4px;
		}
		.summary-dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
		}
		.filters {
			padding: 8px 16px;
			display: flex;
			gap: 8px;
			border-bottom: 1px solid var(--vscode-panel-border, #333);
		}
		.filter-btn {
			padding: 2px 8px;
			font-size: 11px;
			border: 1px solid var(--vscode-button-border, #555);
			border-radius: 3px;
			background: transparent;
			color: var(--vscode-editor-foreground, #d4d4d4);
			cursor: pointer;
		}
		.filter-btn.active {
			background: var(--vscode-button-background, #0e639c);
			color: var(--vscode-button-foreground, #fff);
		}
		.graph-container {
			width: 100%;
			height: calc(100vh - 140px);
			overflow: auto;
		}
		.node-list {
			padding: 8px 16px;
		}
		.node-item {
			width: 100%;
			border: 0;
			background: transparent;
			color: inherit;
			font: inherit;
			text-align: left;
			padding: 6px 8px;
			margin: 2px 0;
			border-radius: 3px;
			cursor: pointer;
			display: flex;
			align-items: center;
			gap: 8px;
			font-size: 12px;
		}
		.node-item:hover {
			background: var(--vscode-list-hoverBackground, #2a2d2e);
		}
		.node-dot {
			width: 10px;
			height: 10px;
			border-radius: 50%;
			flex-shrink: 0;
		}
		.node-label {
			flex: 1;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.node-path {
			max-width: 50%;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 10px;
			opacity: 0.6;
		}
		.depth-indent {
			display: inline-block;
		}
		.header .target { overflow-wrap: anywhere; }
		.summary, .filters { flex-wrap: wrap; }
		:where(button):focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
		@media (max-width: 600px) {
			.node-item { flex-wrap: wrap; }
			.node-path { flex-basis: 100%; max-width: 100%; }
		}
	</style>
</head>
<body>
	<div class="header">
		<h2>Impact Analysis</h2>
		<div class="target">${escapeHtml(data.target.name)} — ${escapeHtml(data.target.filePath)}</div>
	</div>
	${data.evidence ? `<p>${escapeHtml(data.evidence)}</p>` : data.fileBased ? `<p>${escapeHtml(vscode.l10n.t('File dependencies within three levels. Caller depth, test coverage, and documentation links are not supplied by this backend.'))}</p>` : ''}
	${data.truncated ? `<p>${escapeHtml(vscode.l10n.t('Results reached the traversal or time limit; additional callers may exist.'))}</p>` : ''}
	<div class="summary">
		<div class="summary-item">
			<div class="summary-dot" style="background: #e74c3c"></div>
			Direct: ${data.summary.directCount}
		</div>
		<div class="summary-item">
			<div class="summary-dot" style="background: #f39c12"></div>
			${data.fileBased ? escapeHtml(vscode.l10n.t('Affected Files')) : 'Transitive'}: ${data.summary.transitiveCount}
		</div>
		<div class="summary-item">
			<div class="summary-dot" style="background: #2ecc71"></div>
			Tests: ${data.summary.testCount}
		</div>
		<div class="summary-item">
			<div class="summary-dot" style="background: #95a5a6"></div>
			Docs: ${data.summary.documentationCount}
		</div>
	</div>
	<div class="filters">
		<button class="filter-btn active" data-filter="all">All</button>
		<button class="filter-btn" data-filter="direct">Direct</button>
		<button class="filter-btn" data-filter="transitive">${data.fileBased ? escapeHtml(vscode.l10n.t('Affected Files')) : 'Transitive'}</button>
		<button class="filter-btn" data-filter="test">Tests</button>
		<button class="filter-btn" data-filter="documentation">Docs</button>
	</div>
	<div class="graph-container">
		<div class="node-list" id="nodeList"></div>
	</div>
	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const nodes = ${nodesJson};
		const edges = ${edgesJson};
		let activeFilter = 'all';

		function renderNodes(filter) {
			const container = document.getElementById('nodeList');
			const filtered = filter === 'all' ? nodes : nodes.filter(n => n.type === filter);

			container.innerHTML = filtered.map(node => {
				const indent = Math.max(0, Math.min(3, node.depth)) * 16;
				// Only the host-issued identity selects a navigation destination.
				return '<button type="button" class="node-item" data-navigation-id="' + escapeAttr(node.navigationId) + '" ' +
					(node.navigationId ? '' : 'disabled ') +
					'title="' + escapeAttr(node.signature || node.label) + '\\n' + escapeAttr(node.filePath) + '">' +
					'<div class="depth-indent" style="width: ' + indent + 'px"></div>' +
					'<div class="node-dot" style="background: ' + escapeAttr(node.color) + '"></div>' +
					'<div class="node-label">' + escapeHtmlJs(node.label) + '</div>' +
					'<div class="node-path">' + escapeHtmlJs(node.filePath) + '</div>' +
					'</button>';
			}).join('');
		}

		function filterNodes(filter) {
			activeFilter = filter;
			document.querySelectorAll('.filter-btn').forEach(btn => {
				btn.classList.toggle('active', btn.dataset.filter === filter);
			});
			renderNodes(filter);
		}

		function escapeHtmlJs(text) {
			return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}

		function escapeAttr(text) {
			return String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
		}

		// Strict CSP blocks inline event handlers, so wire behaviour via listeners.
		document.querySelectorAll('.filter-btn').forEach(btn => {
			btn.addEventListener('click', () => filterNodes(btn.dataset.filter || 'all'));
		});
		document.getElementById('nodeList').addEventListener('click', (e) => {
			const item = e.target.closest('.node-item');
			if (item && item.dataset.navigationId) {
				vscode.postMessage({ command: 'navigateToFile', navigationId: item.dataset.navigationId });
			}
		});

		renderNodes('all');
	</script>
</body>
</html>`;
	}

	private dispose(): void {
		ImpactAnalysisPanel.currentPanel = undefined;
		this.navigation.clear();
		this.panel.dispose();
		while (this.disposables.length) {
			const x = this.disposables.pop();
			x?.dispose();
		}
	}
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
