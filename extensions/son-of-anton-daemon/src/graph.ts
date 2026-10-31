/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { NodeSession } from '@codypendent/protocol/node';
import type { Payload } from '@codypendent/protocol';
import { ensureDaemon, getRuntimeEndpoint } from './runtime.js';
import { graphColumnOffset, resolveGraphSource } from './graphNavigation.js';
import { GraphHistory, type GraphSelection, type GraphViewPosition } from './graphHistory.js';
import { renderGraphHtml, renderGraphLoadingHtml } from './graphView.js';

/** Browse the execution engine's recorded graph without turning structural evidence into coverage claims. */
export function registerGraphCommands(context: vscode.ExtensionContext): void {
	const panels = new Set<vscode.WebviewPanel>();
	context.subscriptions.push({ dispose: () => { for (const panel of panels) { panel.dispose(); } panels.clear(); } });
	const run = async (build: boolean, selectedPath?: string, name?: string): Promise<void> => {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const folder = selectedPath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(selectedPath)) : folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
		if (!folder || folder.uri.scheme !== 'file') { throw new Error(vscode.l10n.t('Open and select a local repository first.')); }
		const repository = await realpath(folder.uri.fsPath);
		const selected = selectedPath ? path.relative(repository, await realpath(selectedPath)).split(path.sep).join('/') : undefined;
		if (selected && (selected === '..' || selected.startsWith('../') || path.isAbsolute(selected))) { throw new Error(vscode.l10n.t('The selected file is outside this repository.')); }
		const endpoint = getRuntimeEndpoint();
		await ensureDaemon(context, endpoint);
		const session = new NodeSession({
			socketPath: endpoint.socketPath, clientName: 'son-of-anton-graph',
			canWrite: () => vscode.workspace.isTrusted, onChange: () => { }, onError: () => { }
		});
		const panel = vscode.window.createWebviewPanel('sota.graphInspector', vscode.l10n.t('Code Graph'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
		panels.add(panel);
		let disposed = false;
		let version = 0;
		let processing = false;
		const history = new GraphHistory({ path: selected, name });
		let status: Extract<Payload, { type: 'CodeGraphStatus' }>['status'] | undefined;
		let page: Extract<Payload, { type: 'CodeGraphPage' }>['page'] | undefined;
		let scan: Payload | undefined;
		const sources = new Map<string, Parameters<typeof resolveGraphSource>[1]>();
		const checkEndpoint = (): void => {
			if (disposed || getRuntimeEndpoint().identity !== endpoint.identity) { throw new Error(vscode.l10n.t('The agent runtime connection changed. Close and reopen this graph inspector.')); }
		};
		const refresh = async (selection = history.current.selection, navigation: 'visit' | 'back' = 'visit',
			returnPosition: GraphViewPosition = history.current.position, position = returnPosition): Promise<void> => {
			checkEndpoint();
			const statusReply = await session.readService({ type: 'ReadCodeGraphStatus', repository });
			const graphReply = await session.readService({
				type: 'ReadCodeGraph', repository, query: {
					...(selection.nodeId ? { node_id: selection.nodeId } : { path: selection.path, name: selection.name }),
					connected_view: !selection.nodeId && !selection.path && !selection.name,
					include_neighbors: true, include_edges: true, include_nodes: true, limit: 200,
				}
			});
			checkEndpoint();
			if (statusReply.type !== 'CodeGraphStatus' || graphReply.type !== 'CodeGraphPage') { throw new Error(vscode.l10n.t('The agent runtime did not return a code graph page and status.')); }
			status = statusReply.status; page = graphReply.page;
			if (navigation === 'back') { history.back(); } else { history.visit(selection, returnPosition, position); }
			sources.clear();
			for (const node of [...page.nodes, ...(page.related_nodes ?? [])]) {
				const location = node.location ?? (node.source_path ? { source_path: node.source_path, line: 1, column: 1 } : undefined);
				if (location) { sources.set(`node:${node.id}`, location); }
			}
			page.edges.forEach((edge, index) => { if (edge.call_site) { sources.set(`edge:${index}`, edge.call_site); } });
			panel.webview.html = renderGraphHtml({
				nonce: randomBytes(24).toString('hex'), version: ++version, repository,
				selection: history.current.selection, canGoBack: !!history.previous, position: history.current.position,
				status, page, localize: (text, ...args) => vscode.l10n.t(text, ...args)
			});
		};
		const listener = panel.webview.onDidReceiveMessage((message: {
			type?: string; version?: number; nodeId?: string; sourceId?: string;
			path?: string; name?: string; position?: GraphViewPosition;
		}) => {
			if (!message || message.version !== version || !page || processing) { return; }
			processing = true;
			const position: GraphViewPosition = {
				scrollY: Number.isFinite(message.position?.scrollY) ? Math.max(0, Math.min(message.position!.scrollY, 100_000_000)) : 0,
				focus: typeof message.position?.focus === 'string' ? message.position.focus.slice(0, 4096) : undefined,
			};
			void (async () => {
				checkEndpoint();
				if (message.type === 'refresh') { await refresh(history.current.selection, 'visit', position); }
				else if (message.type === 'query' && typeof message.path === 'string' && typeof message.name === 'string' && message.path.length <= 2048 && message.name.length <= 2048) {
					const selection: GraphSelection = { path: message.path.trim() || undefined, name: message.name.trim() || undefined };
					await refresh(selection, 'visit', position, { scrollY: 0, focus: position.focus?.startsWith('query-') ? position.focus : 'query-name' });
				} else if (message.type === 'reset') {
					await refresh({}, 'visit', position, { scrollY: 0, focus: 'query-path' });
				} else if (message.type === 'back' && history.previous) {
					await refresh(history.previous.selection, 'back');
				} else if (message.type === 'select' && typeof message.nodeId === 'string') {
					if (![...page.nodes, ...(page.related_nodes ?? [])].some(node => node.id === message.nodeId)) { return; }
					await refresh({ ...history.current.selection, nodeId: message.nodeId }, 'visit', position, { scrollY: 0, focus: 'selection' });
				} else if (message.type === 'open' && typeof message.sourceId === 'string') {
					const location = sources.get(message.sourceId);
					if (!location) { return; }
					const filename = await resolveGraphSource(repository, location).catch(() => { throw new Error(vscode.l10n.t('The recorded source is unavailable or outside this repository.')); });
					const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filename));
					checkEndpoint();
					const line = Math.min(location.line - 1, document.lineCount - 1);
					const position = new vscode.Position(line, graphColumnOffset(document.lineAt(line).text, location.column));
					await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
				} else if (message.type === 'raw') {
					const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ repository, selection: history.current.selection, scan, status, graph: page }, null, 2) });
					await vscode.window.showTextDocument(document, { preview: true });
				}
			})().catch(error => { if (!disposed) { void panel.webview.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error), version }); } })
				.finally(() => { processing = false; if (!disposed) { void panel.webview.postMessage({ type: 'ready', version }); } });
		});
		panel.webview.html = renderGraphLoadingHtml(repository, (text, ...args) => vscode.l10n.t(text, ...args));
		const disposalListener = panel.onDidDispose(() => {
			disposed = true; panels.delete(panel); listener.dispose(); disposalListener.dispose(); session.disconnect();
		});
		try {
			await session.connect();
			if (build) { checkEndpoint(); scan = await session.buildCodeGraph(repository); }
			await refresh();
		} catch (error) { panel.dispose(); throw error; }
	};
	context.subscriptions.push(vscode.commands.registerCommand('sota.daemon.graph', (selectedPath?: string, name?: string) => run(false, selectedPath, name)),
		vscode.commands.registerCommand('sota.daemon.graph.build', () => run(true)));
}
