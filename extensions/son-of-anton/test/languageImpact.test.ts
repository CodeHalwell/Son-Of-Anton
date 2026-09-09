/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { fileImpactPaths, languageImpact } from '../src/impact/LanguageImpact';

suite('Impact evidence paths', () => {
	test('file fallback keeps real intermediate edges instead of linking every result to the target', () => {
		const data = fileImpactPaths('/project/root.ts', [['/project/caller.ts', '/project/root.ts'], ['/project/test.ts', '/project/caller.ts', '/project/root.ts']]);
		assert.deepEqual([data.nodes.map(node => [node.filePath, node.depth]), data.edges.map(edge => [edge.source, edge.target]), data.summary.testCount], [[['/project/caller.ts', 1], ['/project/test.ts', 2]], [['file-0', 'root'], ['file-1', 'file-0']], 0]);
	});
	test('language hierarchy supplies caller identity, lines and test dependency evidence', async () => {
		const old = vscode.commands.executeCommand;
		const item = (name: string, filename: string, line: number) => ({ name, uri: vscode.Uri.file(filename), selectionRange: { start: { line, character: 0 } } }) as vscode.CallHierarchyItem;
		const root = item('target', '/project/root.ts', 1), caller = item('caller', '/project/caller.ts', 4), test = item('checksTarget', '/project/check.test.ts', 8);
		Object.assign(vscode.commands, { executeCommand: async (command: string, value: vscode.CallHierarchyItem) => command === 'vscode.prepareCallHierarchy' ? [root] : value.name === 'target' ? [{ from: caller, fromRanges: [] }] : value.name === 'caller' ? [{ from: test, fromRanges: [] }] : [] });
		try {
			const data = await languageImpact({ version: 3, uri: root.uri, isDirty: true, isClosed: false } as vscode.TextDocument, { line: 1, character: 0 } as vscode.Position);
			assert.deepEqual(data?.nodes.map(node => [node.label, node.line, node.depth, node.type]), [['caller', 5, 1, 'direct'], ['checksTarget', 9, 2, 'test']]);
			assert.equal(data?.edges[1].target, 'caller-0');
			assert.match(data?.evidence ?? '', /unsaved editor version 3/);
		} finally { Object.assign(vscode.commands, { executeCommand: old }); }
	});
	test('test grouping accepts full directory segments or filename suffixes, not partial path matches', async () => {
		const cases: Array<[string, boolean]> = [
			['/project/test/caller.ts', true], ['/project/tests/caller.ts', true], ['/project/__tests__/caller.ts', true],
			['/project/caller.test.ts', true], ['/project/caller.spec.tsx', true], ['/project/caller_test.go', true],
			['C:\\project\\tests\\caller.ts', true], ['C:\\project\\caller.spec.ts', true],
			['/project/contest/caller.ts', false], ['/project/tests-helper/caller.ts', false], ['/project/__tests__backup/caller.ts', false],
			['/project/caller.test.ts/source.ts', false], ['/project/caller_test', false], ['/project/caller.ts', false],
		];
		const old = vscode.commands.executeCommand;
		const item = (name: string, filePath: string) => ({ name, uri: { scheme: 'file', fsPath: filePath, toString: () => filePath }, selectionRange: { start: { line: 0, character: 0 } } }) as vscode.CallHierarchyItem;
		const root = item('target', '/project/root.ts');
		Object.assign(vscode.commands, { executeCommand: async (command: string, value: vscode.CallHierarchyItem) => command === 'vscode.prepareCallHierarchy' ? [root] : value === root ? cases.map(([file], index) => ({ from: item(`caller${index}`, file), fromRanges: [] })) : [] });
		try {
			const result = await languageImpact({ version: 1, uri: root.uri, isDirty: false, isClosed: false } as vscode.TextDocument, { line: 0, character: 0 } as vscode.Position);
			assert.deepEqual(result?.nodes.map(node => [node.filePath, node.type === 'test']), cases);
			assert.equal(result?.edges.length, cases.length, 'Classification must not invent or remove provider call edges');
		} finally { Object.assign(vscode.commands, { executeCommand: old }); }
	});
});
