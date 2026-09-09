/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ImpactAnalysisPanel, type ImpactAnalysisData, type ImpactNode } from '../src/impact/ImpactAnalysisPanel';

function data(nodes: ImpactNode[]): ImpactAnalysisData {
	return { target: { name: 'target', filePath: 'target.ts' }, nodes, edges: [], summary: { directCount: nodes.length, transitiveCount: 0, testCount: 0, documentationCount: 0 } };
}
function caller(id: string, line?: number): ImpactNode { return { id, label: id, filePath: 'callers.ts', line, type: 'direct', depth: 1 }; }

function fixture(run: (value: {
	panel: ImpactAnalysisPanel; root: string; receive(message: unknown): void; rendered(): Array<{ navigationId?: string; filePath: string }>;
	opened: Array<{ filePath: string; line: number | undefined }>; close(): void;
}) => void): void {
	const create = vscode.window.createWebviewPanel, show = vscode.window.showTextDocument, folders = vscode.workspace.workspaceFolders;
	const root = path.resolve('impact-fixture-workspace');
	let receive!: (message: unknown) => void; let closeListener!: () => void; let closed = false;
	const opened: Array<{ filePath: string; line: number | undefined }> = [];
	const nativePanel = {
		webview: { html: '', onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; } },
		onDidDispose: (listener: () => void) => { closeListener = listener; return { dispose() {} }; }, reveal() {},
		dispose: () => { if (!closed) { closed = true; closeListener?.(); } },
	};
	vscode.window.createWebviewPanel = () => nativePanel as unknown as vscode.WebviewPanel;
	vscode.window.showTextDocument = (async (uri: vscode.Uri, options?: vscode.TextDocumentShowOptions) => { opened.push({ filePath: uri.fsPath, line: options?.selection?.start.line }); return undefined; }) as unknown as typeof vscode.window.showTextDocument;
	Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root), name: 'Impact fixture', index: 0 }] });
	try {
		const panel = ImpactAnalysisPanel.createOrShow(vscode.Uri.file(root));
		run({ panel, root, receive: message => receive(message), opened, close: () => nativePanel.dispose(), rendered: () => {
			const nodes = /const nodes = (.*);/.exec(nativePanel.webview.html); assert.ok(nodes); return JSON.parse(nodes[1]);
		} });
	} finally { nativePanel.dispose(); vscode.window.createWebviewPanel = create; vscode.window.showTextDocument = show; Object.assign(vscode.workspace, { workspaceFolders: folders }); }
}

suite('Impact navigation identities', () => {
	test('same-file callers retain separate lines and file-only navigation without mutating input', () => {
		fixture(f => {
			const original = data([caller('first', 12), caller('second', 38), caller('file-only')]); const before = structuredClone(original);
			for (const node of original.nodes) { Object.freeze(node); } Object.freeze(original.nodes); Object.freeze(original);
			f.panel.update(original); const nodes = f.rendered();
			for (const node of nodes) { f.receive({ command: 'navigateToFile', navigationId: node.navigationId }); }
			assert.equal(new Set(nodes.map(node => node.navigationId)).size, 3);
			assert.deepEqual(f.opened, [11, 37, undefined].map(line => ({ filePath: path.join(f.root, 'callers.ts'), line })));
			assert.deepEqual(original, before);
		});
	});

	test('invalid lines become file-only targets and forged navigation payloads are rejected', () => {
		fixture(f => {
			const invalid = [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
			f.panel.update(data(invalid.map((line, index) => caller(`invalid-${index}`, line)))); const nodes = f.rendered();
			for (const node of nodes) { f.receive({ command: 'navigateToFile', navigationId: node.navigationId }); }
			assert.deepEqual(f.opened, invalid.map(() => ({ filePath: path.join(f.root, 'callers.ts'), line: undefined })));
			f.opened.length = 0;
			for (const message of [null, {}, { command: 'navigateToFile' }, { command: 'navigateToFile', navigationId: 'forged' },
				{ command: 'navigateToFile', filePath: path.join(f.root, 'callers.ts'), line: 12 },
				{ command: 'navigateToFile', navigationId: nodes[0].navigationId, filePath: path.join(f.root, 'other.ts') },
				{ command: 'navigateToFile', navigationId: nodes[0].navigationId, line: 999 },
				{ command: 'other', navigationId: nodes[0].navigationId }]) { f.receive(message); }
			assert.deepEqual(f.opened, []);
		});
	});

	test('render replacement and disposal invalidate old navigation identities', () => {
		fixture(f => {
			f.panel.update(data([caller('old', 4)])); const old = f.rendered()[0].navigationId;
			f.panel.update(data([caller('new', 51)])); const current = f.rendered()[0].navigationId; assert.notEqual(old, current);
			f.receive({ command: 'navigateToFile', navigationId: old }); assert.deepEqual(f.opened, []);
			f.receive({ command: 'navigateToFile', navigationId: current });
			assert.deepEqual(f.opened, [{ filePath: path.join(f.root, 'callers.ts'), line: 50 }]);
			f.close(); f.opened.length = 0; f.receive({ command: 'navigateToFile', navigationId: current }); assert.deepEqual(f.opened, []);
		});
	});
});
