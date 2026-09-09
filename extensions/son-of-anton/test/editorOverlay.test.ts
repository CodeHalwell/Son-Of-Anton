/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { McpClient } from 'son-of-anton-core/mcp/McpClient';
import type { CodeGraphBackend } from '../src/codeGraph/CodeGraphBackend';

interface OverlaySnapshot { workspace: string; revision: number; documents: { path: string; version: number; language: string; text: string; outlineAvailable: boolean; symbols: { name: string; kind: string; start: number; end: number }[] }[] }
type CommandSymbol = vscode.DocumentSymbol | vscode.SymbolInformation;
const requireFromTest = createRequire(import.meta.url);

suite('Editor overlay document symbol results', () => {
	const mock = requireFromTest('vscode') as typeof vscode;
	const root = path.resolve('/workspace'), filename = path.join(root, 'sample.ts');
	const text = '// 🧪 café\nfunction café() {}\nfunction sibling() {}\n';
	const uri = mock.Uri.file(filename);
	const range = (line: number, end: number) => new mock.Range(line, 0, line, end);
	const functionRange = range(1, 'function café() {}'.length), siblingRange = range(2, 'function sibling() {}'.length);
	const flat = (name: string, symbolRange: vscode.Range, symbolUri = uri): vscode.SymbolInformation => ({ name, kind: 11, containerName: '', location: { uri: symbolUri, range: symbolRange } });
	const hierarchical = (name: string, symbolRange: vscode.Range, children: vscode.DocumentSymbol[] = []): vscode.DocumentSymbol => ({ name, kind: 11, detail: '', range: symbolRange, selectionRange: symbolRange, children });
	const expected = (name: string, line: number) => {
		const lines = text.split('\n'), prefix = lines.slice(0, line).join('\n') + '\n';
		return { name, kind: 'Function', start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + lines[line]) };
	};

	async function snapshot(provide: (document: vscode.TextDocument) => Promise<CommandSymbol[] | undefined>): Promise<OverlaySnapshot> {
		const original = {
			symbolKind: mock.SymbolKind, createStatusBarItem: mock.window.createStatusBarItem, executeCommand: mock.commands.executeCommand,
			workspace: Object.fromEntries(['textDocuments', 'workspaceFolders', 'isTrusted', 'getConfiguration', 'onDidChangeTextDocument', 'onDidSaveTextDocument', 'onDidCloseTextDocument', 'onDidOpenTextDocument', 'onDidChangeWorkspaceFolders', 'onDidGrantWorkspaceTrust', 'onDidChangeConfiguration'].map(key => [key, Reflect.get(mock.workspace, key)])),
		};
		const subscriptions: vscode.Disposable[] = [], commands: string[] = [];
		const document = { uri, version: 3, languageId: 'typescript', isDirty: true, isClosed: false, getText: () => text, offsetAt: (position: vscode.Position) => text.split('\n').slice(0, position.line).reduce((offset, line) => offset + line.length + 1, 0) + position.character } as vscode.TextDocument;
		const disposable = { dispose() {} };
		let received!: (value: OverlaySnapshot) => void;
		const notification = new Promise<OverlaySnapshot>(resolve => { received = resolve; });
		try {
			Object.assign(mock, { SymbolKind: { 11: 'Function' } });
			Object.assign(mock.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
			Object.assign(mock.workspace, {
				textDocuments: [document], workspaceFolders: [{ uri: mock.Uri.file(root), name: 'workspace', index: 0 }], isTrusted: true,
				getConfiguration: () => ({ get: (_key: string, fallback: boolean) => fallback }),
				onDidChangeTextDocument: () => disposable, onDidSaveTextDocument: () => disposable, onDidCloseTextDocument: () => disposable, onDidOpenTextDocument: () => disposable,
				onDidChangeWorkspaceFolders: () => disposable, onDidGrantWorkspaceTrust: () => disposable, onDidChangeConfiguration: () => disposable,
			});
			mock.commands.executeCommand = (async (command: string, requestedUri: vscode.Uri) => { commands.push(command); assert.equal(requestedUri.toString(), uri.toString()); return provide(document); }) as typeof mock.commands.executeCommand;
			const client = { onDidChangeTools: () => disposable, notifyServer: async (server: string, method: string, params: OverlaySnapshot, command: string) => {
				assert.deepEqual([server, method, command], ['code-graph', 'notifications/son-of-anton/editor-overlay', 'embedded-code-graph']); received(params); return true;
			} } as unknown as McpClient;
			const backend = { currentState: 'embedded', getMcpServerEntry: () => ({ command: 'embedded-code-graph' }) } as unknown as CodeGraphBackend;
			const { registerEditorOverlay } = requireFromTest('../src/codeGraph/EditorOverlay') as typeof import('../src/codeGraph/EditorOverlay');
			registerEditorOverlay({ subscriptions } as vscode.ExtensionContext, client, () => backend);
			const result = await notification;
			assert.deepEqual(commands, ['vscode.executeDocumentSymbolProvider']);
			assert.deepEqual([result.workspace, result.revision, result.documents[0]?.version, result.documents[0]?.text], [root, 1, 3, text]);
			return result;
		} finally {
			for (const subscription of subscriptions) { subscription.dispose(); }
			Object.assign(mock, { SymbolKind: original.symbolKind }); Object.assign(mock.window, { createStatusBarItem: original.createStatusBarItem });
			mock.commands.executeCommand = original.executeCommand; Object.assign(mock.workspace, original.workspace);
		}
	}

	test('flat SymbolInformation command results reach MCP with UTF-8 byte offsets', async () => {
		const result = await snapshot(async () => [flat('café', functionRange), flat('sibling', siblingRange)]);
		assert.deepEqual([result.documents[0].outlineAvailable, result.documents[0].symbols], [true, [expected('café', 1), expected('sibling', 2)]]);
	});
	test('DocumentSymbol and current hybrid command results retain their child traversal', async () => {
		// extHostApiCommands.MergedInfo exposes SymbolInformation.location together with range and children.
		const child = hierarchical('nested', siblingRange), hybrid = Object.assign(flat('hybrid', functionRange), hierarchical('hybrid', functionRange, [child]));
		const result = await snapshot(async () => [hierarchical('document', functionRange, [child]), hybrid]);
		assert.deepEqual([result.documents[0].outlineAvailable, result.documents[0].symbols], [true, [expected('document', 1), expected('nested', 2), expected('hybrid', 1), expected('nested', 2)]]);
	});
	test('unusable and foreign symbols do not truncate valid following siblings', async () => {
		const unusable = { name: 'no-range', kind: 11 } as vscode.SymbolInformation;
		const result = await snapshot(async () => [unusable, flat('foreign', functionRange, mock.Uri.file(path.join(root, 'other.ts'))), flat('sibling', siblingRange)]);
		assert.deepEqual([result.documents[0].outlineAvailable, result.documents[0].symbols], [true, [expected('sibling', 2)]]);
	});
	test('nonempty unusable results do not advertise an available outline', async () => {
		const result = await snapshot(async () => [{ name: 'no-range', kind: 11 } as vscode.SymbolInformation]);
		assert.deepEqual([result.documents[0].outlineAvailable, result.documents[0].symbols], [false, []]);
	});
	test('an empty successful outline is distinct from a failed or unavailable provider', async () => {
		const empty = await snapshot(async () => []), missing = await snapshot(async () => undefined), failed = await snapshot(async () => { throw new Error('Provider unavailable'); });
		assert.deepEqual([empty, missing, failed].map(value => [value.documents[0].outlineAvailable, value.documents[0].symbols]), [[true, []], [false, []], [false, []]]);
	});
});
