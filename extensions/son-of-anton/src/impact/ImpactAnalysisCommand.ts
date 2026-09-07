/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Registers the "Show Impact Analysis" command and context menu item.
 * Queries the code graph MCP server for impact data and displays
 * it in the ImpactAnalysisPanel.
 */

import * as vscode from 'vscode';
import { McpClient } from 'son-of-anton-core/mcp/McpClient';
import { ImpactAnalysisPanel, ImpactAnalysisData, ImpactNode, ImpactEdge } from './ImpactAnalysisPanel';

export function registerImpactAnalysisCommand(
	context: vscode.ExtensionContext,
	mcpClient: McpClient,
): void {
	const command = vscode.commands.registerCommand(
		'sota.showImpactAnalysis',
		async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showWarningMessage('No active editor. Open a file to analyze impact.');
				return;
			}

			const document = editor.document;
			const position = editor.selection.active;

			// Get the symbol at cursor using VS Code's built-in symbol provider
			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
				'vscode.executeDocumentSymbolProvider',
				document.uri,
			);

			const targetSymbol = findSymbolAtPosition(symbols ?? [], position);
			const wordRange = document.getWordRangeAtPosition(position);
			const fallbackSymbolName = wordRange ? document.getText(wordRange) : undefined;
			const symbolName = targetSymbol?.name ?? fallbackSymbolName;

			if (!symbolName) {
				vscode.window.showWarningMessage('No symbol found at cursor position.');
				return;
			}

			const filePath = vscode.workspace.asRelativePath(document.uri);

			// Show progress while querying
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Analyzing impact of "${symbolName}"...`,
					cancellable: false,
				},
				async () => {
					try {
						const tool = (await mcpClient.listTools()).find(tool => tool.server === 'code-graph' && tool.tool === 'impact_analysis');
						const fileBased = !!tool?.inputSchema && 'properties' in tool.inputSchema && !!tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object' && 'path' in tool.inputSchema.properties;
						const result = await mcpClient.callTool({
							server: 'code-graph',
							tool: 'impact_analysis',
							inputs: fileBased ? { path: filePath, depth: 3 } : { symbol: symbolName, file: filePath },
						});

						if (result.isError) { throw new Error(result.content); }
						const rawData = JSON.parse(result.content);
						const data = transformToImpactData(symbolName, filePath, rawData);

						const panel = ImpactAnalysisPanel.createOrShow(context.extensionUri);
						panel.update(data);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						vscode.window.showErrorMessage(`Impact analysis failed: ${message}`);
					}
				},
			);
		},
	);

	context.subscriptions.push(command);
}

/**
 * Find the deepest symbol containing the given position.
 */
function findSymbolAtPosition(
	symbols: vscode.DocumentSymbol[],
	position: vscode.Position,
): vscode.DocumentSymbol | undefined {
	for (const symbol of symbols) {
		if (symbol.range.contains(position)) {
			// Check children first for deeper match
			const child = findSymbolAtPosition(symbol.children, position);
			return child ?? symbol;
		}
	}
	return undefined;
}

/**
 * Transform raw MCP impact_analysis response into ImpactAnalysisData.
 */
export function transformToImpactData(
	symbolName: string,
	filePath: string,
	raw: Record<string, unknown> | string[],
): ImpactAnalysisData {
	const nodes: ImpactNode[] = [];
	const edges: ImpactEdge[] = [];

	if (Array.isArray(raw)) {
		const files = [...new Set(raw.filter(file => typeof file === 'string' && file !== filePath))];
		return {
			target: { name: filePath, filePath }, fileBased: true,
			nodes: files.map((file, index) => ({ id: `file-${index}`, label: file, filePath: file, type: 'transitive', depth: 0 })),
			edges: files.map((_file, index) => ({ source: `file-${index}`, target: 'root', relationship: 'depends on' })),
			summary: { directCount: 0, transitiveCount: files.length, testCount: 0, documentationCount: 0 },
		};
	}
	const directCallers = (raw.directCallers ?? raw.direct ?? []) as Array<Record<string, string>>;
	const transitiveCallers = (raw.transitiveCallers ?? raw.transitive ?? []) as Array<Record<string, string>>;
	const testFiles = (raw.testFiles ?? raw.tests ?? []) as Array<Record<string, string>>;
	const documentationFiles = (raw.documentation ?? raw.docs ?? []) as Array<Record<string, string>>;

	for (const caller of directCallers) {
		const id = `direct-${nodes.length}`;
		nodes.push({
			id,
			label: caller.name ?? caller.symbol ?? caller.file ?? 'unknown',
			filePath: caller.file ?? caller.filePath ?? '',
			symbolName: caller.name ?? caller.symbol,
			type: 'direct',
			depth: 1,
			signature: caller.signature,
		});
		edges.push({
			source: id,
			target: 'root',
			relationship: caller.relationship ?? 'calls',
		});
	}

	for (const caller of transitiveCallers) {
		const id = `transitive-${nodes.length}`;
		nodes.push({
			id,
			label: caller.name ?? caller.symbol ?? caller.file ?? 'unknown',
			filePath: caller.file ?? caller.filePath ?? '',
			symbolName: caller.name ?? caller.symbol,
			type: 'transitive',
			depth: parseInt(caller.depth ?? '2', 10),
			signature: caller.signature,
		});
		edges.push({
			source: id,
			target: 'root',
			relationship: caller.relationship ?? 'transitively calls',
		});
	}

	for (const test of testFiles) {
		const id = `test-${nodes.length}`;
		nodes.push({
			id,
			label: test.name ?? test.file ?? 'unknown',
			filePath: test.file ?? test.filePath ?? '',
			type: 'test',
			depth: 1,
		});
		edges.push({
			source: id,
			target: 'root',
			relationship: 'tests',
		});
	}

	for (const doc of documentationFiles) {
		const id = `doc-${nodes.length}`;
		nodes.push({
			id,
			label: doc.name ?? doc.file ?? 'unknown',
			filePath: doc.file ?? doc.filePath ?? '',
			type: 'documentation',
			depth: 1,
		});
		edges.push({
			source: id,
			target: 'root',
			relationship: 'documents',
		});
	}

	return {
		target: {
			name: symbolName,
			filePath,
		},
		nodes,
		edges,
		summary: {
			directCount: directCallers.length,
			transitiveCount: transitiveCallers.length,
			testCount: testFiles.length,
			documentationCount: documentationFiles.length,
		},
	};
}
