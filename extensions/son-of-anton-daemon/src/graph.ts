/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { NodeSession } from '@codypendent/protocol/node';
import { ensureDaemon } from './runtime.js';

/** Query the same graph the Rust workers use, retaining confidence and provenance. */
export function registerGraphCommands(context: vscode.ExtensionContext): void {
	const run = async (build: boolean, selectedPath?: string, name?: string): Promise<void> => {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const folder = selectedPath ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(selectedPath)) : folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
		if (!folder || folder.uri.scheme !== 'file') { throw new Error(vscode.l10n.t('Open and select a local repository first.')); }
		const repository = await realpath(folder.uri.fsPath);
		const selected = selectedPath ? path.relative(repository, await realpath(selectedPath)).split(path.sep).join('/') : undefined;
		if (selected && (selected === '..' || selected.startsWith('../') || path.isAbsolute(selected))) { throw new Error(vscode.l10n.t('The selected file is outside this repository.')); }
		await ensureDaemon(context);
		const session = new NodeSession({ socketPath: vscode.workspace.getConfiguration('sota.daemon').get<string>('socketPath') || undefined,
			clientName: 'son-of-anton-graph', canWrite: () => vscode.workspace.isTrusted, onChange: () => {}, onError: () => {} });
		try {
			await session.connect();
			const scan = build ? await session.buildCodeGraph(repository) : undefined;
			const status = await session.readService({ type: 'ReadCodeGraphStatus', repository });
			const graph = await session.readService({ type: 'ReadCodeGraph', repository, query: { path: selected, name,
				include_edges: true, include_nodes: true, limit: 200 } });
			const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({
				capability: vscode.l10n.t('Structural code graph. Edge confidence and evidence are retained; this bounded page does not establish complete impact or test coverage.'),
				scan, status, graph,
			}, null, 2) });
			await vscode.window.showTextDocument(document, { preview: true });
		} finally { session.disconnect(); }
	};
	context.subscriptions.push(vscode.commands.registerCommand('sota.daemon.graph', (selectedPath?: string, name?: string) => run(false, selectedPath, name)),
		vscode.commands.registerCommand('sota.daemon.graph.build', () => run(true)));
}
