/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ImpactAnalysisData, ImpactNode, ImpactEdge } from './ImpactAnalysisPanel';

/** Evidence comes from the language provider's call graph, including its current editor buffers. */
export async function languageImpact(document: vscode.TextDocument, position: vscode.Position): Promise<ImpactAnalysisData | undefined> {
	const version = document.version, deadline = Date.now() + 10_000;
	const request = async <T>(command: string, ...args: object[]): Promise<T | undefined> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try { return await Promise.race([vscode.commands.executeCommand<T>(command, ...args), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.max(1, Math.min(2000, deadline - Date.now()))); })]); }
		catch { return undefined; } finally { if (timer) { clearTimeout(timer); } }
	};
	const prepared = await request<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', document.uri, position);
	const root = prepared?.[0];
	if (!root || document.version !== version) { return undefined; }
	const initial = await request<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', root);
	if (!initial || document.version !== version) { return undefined; }
	const nodes: ImpactNode[] = [], edges: ImpactEdge[] = [], seen = new Map<string, string>();
	const key = (item: vscode.CallHierarchyItem): string => `${item.uri.toString()}:${item.selectionRange.start.line}:${item.selectionRange.start.character}`;
	seen.set(key(root), 'root');
	const queue = [{ item: root, id: 'root', chain: [root.name], calls: initial, depth: 0 }];
	let truncated = false;
	while (queue.length && nodes.length < 80 && Date.now() < deadline) {
		const next = queue.shift()!;
		for (const call of next.calls) {
			if (call.from.uri.scheme !== 'file') { continue; }
			const item = call.from, existing = seen.get(key(item)), id = existing ?? `caller-${nodes.length}`;
			edges.push({ source: id, target: next.id, relationship: vscode.l10n.t('Calls (Language Server)') });
			if (existing) { continue; }
			seen.set(key(item), id);
			const chain = [item.name, ...next.chain], filePath = item.uri.fsPath;
			// The call edge is exact provider evidence; the filename only groups likely test source files.
			const inTestDirectory = filePath.split(/[/\\]/).slice(0, -1).some(segment => ['test', 'tests', '__tests__'].includes(segment));
			const testFilename = /(?:\.test|\.spec|_test)\.[^/\\]+$/.test(filePath);
			const testFile = inTestDirectory || testFilename;
			nodes.push({ id, label: item.name, filePath, symbolName: item.name, line: item.selectionRange.start.line + 1, type: testFile ? 'test' : next.depth === 0 ? 'direct' : 'transitive', depth: next.depth + 1, signature: chain.join(' → ') });
			if (nodes.length >= 80) { truncated = true; break; }
			if (next.depth < 2) {
				const calls = await request<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item);
				if (calls?.length) { queue.push({ item, id, chain, calls, depth: next.depth + 1 }); }
				if (!calls) { truncated = true; }
			}
		}
	}
	if (document.version !== version || document.isClosed) { return undefined; }
	truncated ||= queue.length > 0;
	return {
		target: { name: root.name, filePath: root.uri.fsPath }, nodes, edges,
		evidence: vscode.l10n.t('Language-server incoming calls, up to three levels. Test-file callers are grouped by filename; this is dependency evidence, not measured test coverage. {0}', document.isDirty ? vscode.l10n.t('Target includes unsaved editor version {0}.', version) : ''),
		truncated,
		summary: { directCount: nodes.filter(node => node.type === 'direct').length, transitiveCount: nodes.filter(node => node.type === 'transitive').length, testCount: nodes.filter(node => node.type === 'test').length, documentationCount: 0 },
	};
}

/** Convert graph edges into navigable file paths, preserving intermediate dependencies. */
export function fileImpactPaths(target: string, paths: string[][], truncated = false): ImpactAnalysisData {
	const nodes: ImpactNode[] = [], edges: ImpactEdge[] = [], seen = new Map([[target, 'root']]), edgeKeys = new Set<string>();
	for (const chain of paths) {
		for (let index = chain.length - 2; index >= 0; index--) {
			const filename = chain[index], parent = chain[index + 1];
			if (!seen.has(filename)) {
				const id = `file-${nodes.length}`; seen.set(filename, id);
				nodes.push({ id, label: path.basename(filename), filePath: filename, depth: chain.length - index - 1, type: chain.length - index === 2 ? 'direct' : 'transitive', signature: chain.slice(index).join(' → ') });
			}
			const source = seen.get(filename)!, destination = seen.get(parent) ?? 'root', key = `${source}:${destination}`;
			if (!edgeKeys.has(key)) { edges.push({ source, target: destination, relationship: vscode.l10n.t('Depends on (Saved Graph)') }); edgeKeys.add(key); }
		}
	}
	return { target: { name: path.basename(target), filePath: target }, fileBased: true, evidence: vscode.l10n.t('Paths from the persisted file-dependency graph. Unsaved call edges and measured test coverage are unavailable in this fallback.'), truncated, nodes, edges, summary: { directCount: nodes.filter(node => node.type === 'direct').length, transitiveCount: nodes.filter(node => node.type === 'transitive').length, testCount: 0, documentationCount: 0 } };
}
