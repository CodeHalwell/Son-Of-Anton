/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { McpClient } from 'son-of-anton-core/mcp/McpClient';
import type { CodeGraphBackend } from './CodeGraphBackend';

interface DocumentOverlay { path: string; version: number; language: string; text: string; outlineAvailable: boolean; symbols: { name: string; kind: string; start: number; end: number }[] }
type OutlineSymbol = vscode.DocumentSymbol | vscode.SymbolInformation;
const SUPPORTED_LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'python', 'rust', 'go', 'java', 'c', 'cpp', 'csharp', 'ruby', 'php', 'swift', 'kotlin', 'scala', 'vue', 'svelte']);

/** Synchronize dirty editor buffers to the already-running bundled graph; no unsaved content is persisted. */
export function registerEditorOverlay(context: vscode.ExtensionContext, client: McpClient, backend: () => CodeGraphBackend | undefined): void {
	let revision = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
	status.name = vscode.l10n.t('Code Graph Editor Overlay');
	status.command = 'sota.codeGraph.showStatus';
	context.subscriptions.push(status);
	const send = async (generation: number): Promise<void> => {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, graph = backend(), command = graph?.getMcpServerEntry()?.command;
		if (disposed || !root || !command || graph?.currentState !== 'embedded') { status.hide(); return; }
		const enabled = vscode.workspace.isTrusted && vscode.workspace.getConfiguration('sota').get('codeGraph.editorOverlay', true);
		let totalBytes = 0;
		const documents = enabled ? vscode.workspace.textDocuments.filter(document => {
			const relative = path.relative(root, document.uri.fsPath);
			if (document.uri.scheme !== 'file' || !document.isDirty || document.isClosed || !SUPPORTED_LANGUAGES.has(document.languageId) || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || /(^|[/\\])(node_modules|\.git|target|dist|out)([/\\]|$)/.test(relative)) { return false; }
			const bytes = Buffer.byteLength(document.getText());
			if (bytes > 256 * 1024 || totalBytes + bytes > 2 * 1024 * 1024) { return false; }
			totalBytes += bytes; return true;
		}).slice(0, 32) : [];
		const snapshots: DocumentOverlay[] = [];
		for (const document of documents) {
			if (generation !== revision || disposed) { return; }
			const version = document.version, text = document.getText();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			let provided: OutlineSymbol[] | undefined;
			try {
				provided = await Promise.race([
					vscode.commands.executeCommand<OutlineSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri),
					new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 1500); }),
				]);
			} catch { /* Text matching remains available when a language server has no outline. */ }
			finally { if (timeout) { clearTimeout(timeout); } }
			if (generation !== revision || document.version !== version || !document.isDirty || document.isClosed || disposed) { return; }
			const symbols: DocumentOverlay['symbols'] = [];
			const visit = (entries: OutlineSymbol[]): void => {
				for (const symbol of entries) {
					if (symbols.length >= 1000) { break; }
					if (!symbol || typeof symbol !== 'object') { continue; }
					// The command may return flat SymbolInformation, DocumentSymbol, or hybrid objects with children.
					const location = 'location' in symbol ? symbol.location : undefined;
					const range = ('range' in symbol ? symbol.range : undefined) ?? location?.range;
					if (range?.start && range.end && (!location || location.uri?.toString() === document.uri.toString())) {
						const start = document.offsetAt(range.start), end = document.offsetAt(range.end);
						if (start <= end) {
							symbols.push({ name: symbol.name, kind: vscode.SymbolKind[symbol.kind] ?? String(symbol.kind), start: Buffer.byteLength(text.slice(0, start)), end: Buffer.byteLength(text.slice(0, end)) });
						}
					}
					if ('children' in symbol && Array.isArray(symbol.children)) { visit(symbol.children); }
				}
			};
			if (Array.isArray(provided)) { visit(provided); }
			snapshots.push({ path: document.uri.fsPath, version, language: document.languageId, text, symbols, outlineAvailable: Array.isArray(provided) && (provided.length === 0 || symbols.length > 0) });
		}
		if (generation !== revision || disposed) { return; }
		const sent = await client.notifyServer('code-graph', 'notifications/son-of-anton/editor-overlay', { workspace: root, revision: generation, documents: snapshots }, command);
		if (disposed || generation !== revision) { return; }
		if (sent && snapshots.length) {
			status.text = vscode.l10n.t('$(edit) Graph: {0} Unsaved', snapshots.length);
			status.tooltip = vscode.l10n.t('Unsaved editor outlines and local text matches are available to graph retrieval. File dependencies use the saved index. Buffers are kept in memory only.'); status.show();
		} else { status.hide(); }
	};
	const schedule = (): void => {
		revision++;
		if (timer) { clearTimeout(timer); }
		timer = setTimeout(() => { timer = undefined; void send(revision).catch(() => status.hide()); }, 400);
	};
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(schedule), vscode.workspace.onDidSaveTextDocument(schedule), vscode.workspace.onDidCloseTextDocument(schedule), vscode.workspace.onDidOpenTextDocument(schedule), vscode.workspace.onDidChangeWorkspaceFolders(schedule), vscode.workspace.onDidGrantWorkspaceTrust(schedule), vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('sota.codeGraph.editorOverlay')) { schedule(); } }), client.onDidChangeTools(schedule));
	context.subscriptions.push({ dispose: () => { disposed = true; revision++; if (timer) { clearTimeout(timer); } } });
	schedule();
}
