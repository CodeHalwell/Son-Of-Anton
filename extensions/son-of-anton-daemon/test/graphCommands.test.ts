/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
import type { CommandBody, Payload } from '@codypendent/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ReadGraph = Extract<CommandBody, { type: 'ReadCodeGraph' | 'ReadCodeGraphStatus' }>;
interface GraphMessage { type: string; version: number; nodeId?: string; path?: string; name?: string; position?: { scrollY: number; focus?: string } }
const host = vi.hoisted(() => ({
	root: '', endpoint: { socketPath: '/private/anton.sock', identity: 'anton', mode: 'local' as const },
	commands: new Map<string, (selectedPath?: string, name?: string) => Promise<void>>(),
	receive: undefined as ((message: GraphMessage) => void) | undefined,
	onDispose: undefined as (() => void) | undefined,
	readService: vi.fn<(operation: ReadGraph) => Promise<Payload>>(),
	postMessage: vi.fn<(message: { type: string; error?: string; version: number }) => Promise<boolean>>(),
	connect: vi.fn(), disconnect: vi.fn(), html: '',
}));
vi.mock('vscode', () => ({
	workspace: { get workspaceFolders() { return [{ uri: { scheme: 'file', fsPath: host.root } }]; }, isTrusted: true },
	window: { createWebviewPanel: () => ({
		webview: { get html() { return host.html; }, set html(value: string) { host.html = value; }, postMessage: host.postMessage,
			onDidReceiveMessage: (callback: (message: GraphMessage) => void) => { host.receive = callback; return { dispose: () => { host.receive = undefined; } }; } },
		onDidDispose: (callback: () => void) => { host.onDispose = callback; return { dispose: () => { host.onDispose = undefined; } }; },
		dispose: () => host.onDispose?.(),
	}) },
	ViewColumn: { Active: 1 },
	commands: { registerCommand: (name: string, callback: (selectedPath?: string, symbolName?: string) => Promise<void>) => { host.commands.set(name, callback); return { dispose: () => { host.commands.delete(name); } }; } },
	l10n: { t: (text: string, ...args: Array<string | number>) => text.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? '')) },
}));
vi.mock('@codypendent/protocol/node', () => ({ NodeSession: class {
	connect = host.connect; disconnect = host.disconnect; readService = host.readService;
} }));
vi.mock('../src/runtime.js', () => ({ ensureDaemon: async () => {}, getRuntimeEndpoint: () => host.endpoint }));
import { registerGraphCommands } from '../src/graph.js';

describe('graph inspector query navigation', () => {
	let subscriptions: vscode.Disposable[];
	let failNextGraph: boolean;
	const query = (): Extract<ReadGraph, { type: 'ReadCodeGraph' }>['query'] => {
		const request = host.readService.mock.calls.filter(([operation]) => operation.type === 'ReadCodeGraph').at(-1)?.[0];
		if (request?.type !== 'ReadCodeGraph') { throw new Error('No graph query was sent.'); }
		return request.query;
	};
	const version = (): number => Number(/data-version="(\d+)"/.exec(host.html)![1]);
	const send = async (message: Omit<GraphMessage, 'version'>): Promise<void> => {
		const ready = host.postMessage.mock.calls.filter(([reply]) => reply.type === 'ready').length;
		host.receive!({ ...message, version: version() });
		await vi.waitFor(() => { expect(host.postMessage.mock.calls.filter(([reply]) => reply.type === 'ready')).toHaveLength(ready + 1); });
	};
	beforeEach(async () => {
		host.root = await mkdtemp(path.join(os.tmpdir(), 'anton-graph-ui-'));
		host.endpoint = { socketPath: '/private/anton.sock', identity: 'anton', mode: 'local' };
		host.commands.clear(); host.connect.mockReset(); host.disconnect.mockReset(); host.postMessage.mockReset(); host.readService.mockReset();
		host.postMessage.mockResolvedValue(true); failNextGraph = false;
		host.readService.mockImplementation(async request => {
			if (request.type === 'ReadCodeGraphStatus') { return { type: 'CodeGraphStatus', command_id: 'fixture-status', status: { repository_root: host.root, files: 1, nodes: 2, edges: 0, head_revision: 'fixture', stale: false, working_tree_dirty: false, revisions: [], by_kind: [], by_language: [] } }; }
			if (failNextGraph) { failNextGraph = false; throw new Error('Synthetic graph read failure'); }
			return { type: 'CodeGraphPage', command_id: 'fixture-page', page: { nodes: ['handler', 'caller'].map(id => ({ id, qualified_name: id, kind: 'function', language: 'typescript', revision: 'fixture' })), edges: [], total_nodes: 2, total_edges: 0, limit: 200 } };
		});
		subscriptions = [];
		registerGraphCommands({ subscriptions } as vscode.ExtensionContext);
		await host.commands.get('sota.daemon.graph')!(undefined, 'handle');
	});
	afterEach(async () => { for (const disposable of subscriptions) { disposable.dispose(); } await rm(host.root, { recursive: true, force: true }); });

	it('drills into exact node identity, returns to filters and position, and queries an unfiltered overview', async () => {
		await send({ type: 'select', nodeId: 'caller', position: { scrollY: 640, focus: 'select:caller' } });
		expect(query()).toEqual({ node_id: 'caller', connected_view: false, include_neighbors: true, include_edges: true, include_nodes: true, limit: 200 });
		await send({ type: 'back' });
		expect(query()).toEqual({ name: 'handle', path: undefined, connected_view: false, include_neighbors: true, include_edges: true, include_nodes: true, limit: 200 });
		expect(host.html).toContain('data-restore-scroll="640" data-restore-focus="select:caller"');
		await send({ type: 'query', path: '  src/  ', name: '  write  ' });
		expect(query()).toMatchObject({ path: 'src/', name: 'write', limit: 200 });
		await send({ type: 'reset' });
		expect(query()).toEqual({ path: undefined, name: undefined, connected_view: true, include_neighbors: true, include_edges: true, include_nodes: true, limit: 200 });
	});

	it('leaves failed queries out of Back history and keeps the successful view usable', async () => {
		await send({ type: 'select', nodeId: 'handler' });
		const successful = host.html;
		failNextGraph = true;
		await send({ type: 'query', path: 'failed/', name: 'missing' });
		expect(host.html).toBe(successful);
		expect(host.postMessage).toHaveBeenCalledWith({ type: 'error', error: 'Synthetic graph read failure', version: version() });
		await send({ type: 'back' });
		expect(query()).toMatchObject({ name: 'handle' });
		expect(query()).not.toHaveProperty('node_id');
	});

	it('rejects stale, unlisted and changed-runtime navigation before querying', async () => {
		const initialReads = host.readService.mock.calls.length;
		host.receive!({ type: 'query', path: 'stale/', name: '', version: version() - 1 });
		await send({ type: 'select', nodeId: 'unlisted-node' });
		expect(host.readService).toHaveBeenCalledTimes(initialReads);
		host.endpoint = { ...host.endpoint, identity: 'different-runtime' };
		await send({ type: 'reset' });
		expect(host.readService).toHaveBeenCalledTimes(initialReads);
		expect(host.postMessage.mock.calls.some(([reply]) => reply.type === 'error' && reply.error?.includes('connection changed'))).toBe(true);
	});
});
