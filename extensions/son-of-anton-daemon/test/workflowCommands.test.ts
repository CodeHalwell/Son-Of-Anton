/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
import type { WorkflowCatalog, WorkflowRunSnapshot } from '@codypendent/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowPanelState } from '../src/workflowView.js';

interface Message { type: string; version: number; catalogRevision?: number; workflowId?: string; inputValues?: Record<string, string>; runId?: string; nodeId?: string }
interface PanelFixture {
	visible: boolean; receive?: (message: Message) => void; onDispose?: () => void; onVisibility?: () => void;
	messages: Array<{ type: string; version: number; state: WorkflowPanelState }>; reveals: number; dispose(): void;
}
const host = vi.hoisted(() => ({
	root: '', trusted: true, identity: 'private-anton', panels: [] as PanelFixture[],
	commands: new Map<string, () => Promise<void>>(), saved: new Map<string, object>(), secrets: new Map<string, string>(),
	storeSecret: vi.fn<(key: string, value: string) => Promise<void>>(), update: vi.fn<(key: string, value: object) => Promise<void>>(),
	onError: undefined as ((error: string) => void) | undefined,
	list: vi.fn<(repository: string) => Promise<WorkflowCatalog>>(),
	start: vi.fn<(id: string, inputs: Record<string, unknown>, repository: string, options: { idempotencyKey: string; expectedDefinitionDigest: string }) => Promise<string>>(),
	read: vi.fn<(id: string) => Promise<WorkflowRunSnapshot>>(),
	pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), retry: vi.fn(), disconnect: vi.fn(), connect: vi.fn(),
}));
vi.mock('vscode', () => ({
	workspace: { get workspaceFolders() { return [{ uri: { scheme: 'file', fsPath: host.root } }]; }, get isTrusted() { return host.trusted; },
		onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }) },
	window: { createWebviewPanel: () => {
		const panel: PanelFixture = { visible: true, messages: [], reveals: 0, dispose: () => panel.onDispose?.() }; host.panels.push(panel);
		return { get visible() { return panel.visible; },
			reveal: () => { panel.reveals++; },
			webview: { html: '', postMessage: (message: { type: string; version: number; state: WorkflowPanelState }) => { panel.messages.push(JSON.parse(JSON.stringify(message))); return Promise.resolve(true); },
				onDidReceiveMessage: (callback: (message: Message) => void) => { panel.receive = callback; return { dispose: () => { panel.receive = undefined; } }; } },
			onDidDispose: (callback: () => void) => { panel.onDispose = callback; return { dispose: () => { panel.onDispose = undefined; } }; },
			onDidChangeViewState: (callback: () => void) => { panel.onVisibility = callback; return { dispose: () => { panel.onVisibility = undefined; } }; },
			dispose: panel.dispose };
	} },
	ViewColumn: { Active: 1 },
	commands: { registerCommand: (name: string, callback: () => Promise<void>) => { host.commands.set(name, callback); return { dispose: () => { host.commands.delete(name); } }; } },
	l10n: { t: (text: string, ...args: Array<string | number>) => text.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? '')) },
}));
vi.mock('@codypendent/protocol/node', () => ({
	NodeSession: class { constructor(options: { onError(error: string): void }) { host.onError = options.onError; }
		connect = host.connect; disconnect = host.disconnect; listWorkflows = host.list; startWorkflow = host.start; readWorkflowRun = host.read;
		pauseWorkflow = host.pause; resumeWorkflow = host.resume; cancelWorkflow = host.cancel; retryWorkflowNode = host.retry; },
	WorkflowCommandError: class extends Error { constructor(message: string, public code: string, public retryable: boolean, public definitiveRejection: boolean) { super(message); } },
}));
vi.mock('../src/runtime.js', () => ({ ensureDaemon: async () => {}, getRuntimeEndpoint: () => ({ identity: host.identity, socketPath: '/fixture/anton.sock', mode: 'local' }) }));
vi.mock('../src/workflowView.js', () => ({ renderWorkflowHtml: () => '<workflow-fixture>' }));
import { WorkflowCommandError } from '@codypendent/protocol/node';
import { registerWorkflowCommands } from '../src/workflows.js';

describe('repository workflow panel authority', () => {
	let subscriptions: vscode.Disposable[];
	const catalog = (): WorkflowCatalog => ({ repository: host.root, items: [{ id: 'review', version: 3, definition_digest: 'a'.repeat(64), source: { type: 'Repository' }, node_count: 1,
		inputs: { target: { input_type: 'github_pull_request', required: true }, enabled: { input_type: 'boolean', required: false } } }], diagnostics: [], truncated: false });
	const currentPanel = (): PanelFixture => host.panels.at(-1)!;
	const state = (panel = currentPanel()): WorkflowPanelState => panel.messages.at(-1)!.state;
	const open = async (): Promise<PanelFixture> => {
		await host.commands.get('sota.daemon.workflows')!(); const panel = currentPanel();
		panel.receive!({ type: 'ready', version: host.panels.length });
		await vi.waitFor(() => { expect(state(panel).loading).toBe(false); }); return panel;
	};
	const send = async (message: Omit<Message, 'version'>, panel = currentPanel()): Promise<void> => {
		panel.receive!({ ...message, version: host.panels.indexOf(panel) + 1 });
		await vi.waitFor(() => { expect(state(panel).busy).toBe(false); });
	};
	const start = async (): Promise<void> => send({ type: 'start', workflowId: 'review', catalogRevision: state().catalogRevision,
		inputValues: { target: '{"url":"https://example.invalid/pull/4"}', enabled: 'false' } });
	beforeEach(async () => {
		vi.useFakeTimers();
		host.root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anton-workflow-ui-')));
		host.trusted = true; host.identity = 'private-anton'; host.panels.length = 0; host.saved.clear(); host.secrets.clear(); host.commands.clear();
		for (const mock of [host.list, host.start, host.read, host.pause, host.resume, host.cancel, host.retry, host.disconnect, host.connect, host.storeSecret, host.update]) { mock.mockReset(); }
		host.storeSecret.mockImplementation(async (key, value) => { host.secrets.set(key, value); });
		host.update.mockImplementation(async (key, value) => { host.saved.set(key, JSON.parse(JSON.stringify(value))); });
		host.list.mockImplementation(async () => catalog()); host.start.mockResolvedValue('launched-run');
		host.read.mockImplementation(async id => ({ workflow_run_id: id, phase: { type: 'Failed' }, nodes: [{ workflow_run_id: id, node_id: 'review-node', state: { type: 'Failed' }, attempt: 1, error: 'Synthetic node failure' }] }));
		subscriptions = [];
		registerWorkflowCommands(Object.assign({ subscriptions } as vscode.ExtensionContext, { workspaceState: { get: (key: string) => host.saved.get(key), update: host.update },
			secrets: { get: async (key: string) => host.secrets.get(key), store: host.storeSecret, delete: async (key: string) => { host.secrets.delete(key); } } }));
		await open();
	});
	afterEach(async () => { for (const disposable of subscriptions) { disposable.dispose(); } vi.useRealTimers(); await rm(host.root, { recursive: true, force: true }); });

	it('launches only explicitly with real JSON inputs, the captured repository and selected definition digest', async () => {
		expect(host.start).not.toHaveBeenCalled();
		await start();
		expect(host.list).toHaveBeenCalledWith(host.root);
		expect(host.start).toHaveBeenCalledExactlyOnceWith('review', { target: { url: 'https://example.invalid/pull/4' }, enabled: false }, host.root,
			{ idempotencyKey: expect.stringMatching(/^[\da-f-]{36}$/), expectedDefinitionDigest: 'a'.repeat(64) });
		expect(state()).toMatchObject({ selectedRunId: 'launched-run', snapshot: { workflow_run_id: 'launched-run' }, runs: [{ id: 'launched-run', workflowId: 'review', version: 3 }] });
	});

	it('rejects stale catalog choices, malformed inputs, unknown workflows and untrusted mutations', async () => {
		const cases: Array<Omit<Message, 'type' | 'version'>> = [
			{ workflowId: 'review', catalogRevision: 0, inputValues: { target: 'true' } },
			{ workflowId: 'not-listed', catalogRevision: 1, inputValues: { target: 'true' } },
			{ workflowId: 'review', catalogRevision: 1, inputValues: { target: 'not JSON' } },
			{ workflowId: 'review', catalogRevision: 1, inputValues: { target: 'true', undeclared: 'true' } },
		];
		for (const message of cases) { await send({ type: 'start', ...message }); expect(state().error).toBeTruthy(); }
		host.trusted = false; await start();
		expect(state().error).toContain('Trust this workspace'); expect(host.start).not.toHaveBeenCalled();
	});

	it('retains an uncertain start across panel closure and reconciles the same intent without automatic replay', async () => {
		host.start.mockRejectedValueOnce(new Error('Synthetic transport timeout'));
		await start(); const request = host.start.mock.calls[0];
		expect(state().pendingStart).toEqual({ workflowId: 'review' });
		currentPanel().dispose(); await open();
		expect(host.start).toHaveBeenCalledTimes(1);
		await start(); expect(host.start).toHaveBeenCalledTimes(1);
		await send({ type: 'reconcile' });
		expect(host.start.mock.calls[1]).toEqual(request);
		expect(state().pendingStart).toBeUndefined(); expect(state().selectedRunId).toBe('launched-run');
	});

	it('requires a refreshed definition after a definitive stale-definition rejection', async () => {
		host.start.mockRejectedValueOnce(new WorkflowCommandError('The workflow definition changed.', 'workflow.definition-changed', false, true));
		await start(); const first = host.start.mock.calls[0][3];
		expect(state().catalog).toBeUndefined(); expect(state().pendingStart).toBeUndefined();
		await start(); expect(host.start).toHaveBeenCalledTimes(1);
		host.list.mockImplementation(async () => { const next = catalog(); next.items[0].definition_digest = 'b'.repeat(64); return next; });
		await send({ type: 'refresh' }); await start();
		expect(host.start.mock.calls[1][3].idempotencyKey).not.toBe(first.idempotencyKey);
		expect(host.start.mock.calls[1][3].expectedDefinitionDigest).toBe('b'.repeat(64));
	});

	it('scopes lifecycle operations to its own selected receipt and displayed nodes', async () => {
		await send({ type: 'cancel', runId: 'arbitrary-foreign-run' }); expect(host.cancel).not.toHaveBeenCalled();
		await start();
		await send({ type: 'retry', runId: 'launched-run', nodeId: 'unlisted-node' }); expect(host.retry).not.toHaveBeenCalled();
		await send({ type: 'pause', runId: 'launched-run' });
		await send({ type: 'resume', runId: 'launched-run' });
		await send({ type: 'retry', runId: 'launched-run', nodeId: 'review-node' });
		await send({ type: 'cancel', runId: 'launched-run' });
		expect([host.pause.mock.calls, host.resume.mock.calls, host.retry.mock.calls, host.cancel.mock.calls]).toEqual([[['launched-run']], [['launched-run']], [['launched-run', 'review-node']], [['launched-run']]]);
	});

	it('does not retarget a panel after endpoint changes and rejects a foreign catalog repository', async () => {
		host.identity = 'foreign-runtime'; await start(); expect(host.start).not.toHaveBeenCalled();
		expect(state().error).toContain('connection changed');
		host.identity = 'private-anton'; host.list.mockImplementation(async () => ({ ...catalog(), repository: '/another/repository' }));
		await send({ type: 'refresh' }); await start();
		expect(state().catalog).toBeUndefined(); expect(host.start).not.toHaveBeenCalled();
	});

	it('bounds snapshots, pauses polling while hidden and disposes observation without cancelling durable work', async () => {
		host.read.mockImplementation(async id => ({ workflow_run_id: id, phase: { type: 'Running' }, nodes: Array.from({ length: 150 }, (_value, index) => ({ workflow_run_id: id, node_id: `node-${index}`, state: { type: 'Pending' }, attempt: 0 })) }));
		await start(); expect(state().snapshot?.nodes).toHaveLength(100); expect(state().snapshotTotalNodes).toBe(150);
		const panel = currentPanel(); panel.visible = false; const reads = host.read.mock.calls.length;
		await vi.advanceTimersByTimeAsync(6000); expect(host.read).toHaveBeenCalledTimes(reads);
		panel.dispose(); expect(vi.getTimerCount()).toBe(0); expect(host.disconnect).toHaveBeenCalledTimes(1); expect(host.cancel).not.toHaveBeenCalled();
	});

	it('clears recovered polling errors without hiding unrelated catalog failures', async () => {
		await start(); host.read.mockRejectedValueOnce(new Error('Synthetic snapshot timeout'));
		await vi.advanceTimersByTimeAsync(3000); expect(state().error).toBe('Synthetic snapshot timeout');
		await vi.advanceTimersByTimeAsync(3000); expect(state().error).toBeUndefined();
		host.list.mockRejectedValueOnce(new Error('Synthetic catalog unavailable'));
		await send({ type: 'refresh' }); expect(state().error).toBe('Synthetic catalog unavailable');
		await vi.advanceTimersByTimeAsync(3000); expect(state().error).toBe('Synthetic catalog unavailable');
	});

	it('protects arbitrary workflow input payloads while receipt bookmarks contain no plaintext inputs', async () => {
		await start(); host.start.mockRejectedValueOnce(new Error('Synthetic transport timeout'));
		await send({ type: 'start', workflowId: 'review', catalogRevision: state().catalogRevision, inputValues: { target: '"private-input-marker"' } });
		expect(JSON.stringify([...host.saved.values()])).not.toContain('private-input-marker');
		expect([...host.secrets.values()][0]).toContain('private-input-marker');
		expect(host.saved.size).toBe(1);
	});

	it('never dispatches or reconciles until protected intent storage succeeds and sanitizes storage exceptions', async () => {
		host.storeSecret.mockRejectedValue(new Error('private-storage-error-marker'));
		await start(); await send({ type: 'reconcile' });
		expect(host.start).not.toHaveBeenCalled(); expect(state().error).not.toContain('private-storage-error-marker');
		host.storeSecret.mockImplementation(async (key, value) => { host.secrets.set(key, value); });
		await send({ type: 'reconcile' }); expect(host.start).toHaveBeenCalledTimes(1);
	});

	it('retains protected reconciliation if the accepted receipt cannot yet be saved', async () => {
		host.update.mockRejectedValueOnce(new Error('private-bookmark-error-marker'));
		await start(); const intent = host.start.mock.calls[0];
		expect(state().selectedRunId).toBe('launched-run'); expect(host.secrets.size).toBe(1);
		expect(state().error).not.toContain('private-bookmark-error-marker');
		currentPanel().dispose(); await open(); await send({ type: 'reconcile' });
		expect(host.start.mock.calls[1]).toEqual(intent); expect(host.saved.size).toBe(1); expect(host.secrets.size).toBe(0);
	});

	it('reuses the same scoped panel instead of creating competing pending-request writers', async () => {
		host.start.mockRejectedValueOnce(new Error('Synthetic transport timeout')); await start();
		const before = [...host.secrets.values()]; await host.commands.get('sota.daemon.workflows')!();
		expect(host.panels).toHaveLength(1); expect(currentPanel().reveals).toBe(1);
		expect([...host.secrets.values()]).toEqual(before); expect(host.start).toHaveBeenCalledTimes(1);
	});

	it('reports a current reconnect handshake failure instead of mistaking it for supersession', async () => {
		await start(); host.onError?.('Synthetic disconnect'); host.connect.mockRejectedValueOnce(new Error('Synthetic handshake failure'));
		await vi.advanceTimersByTimeAsync(3000); expect(state().error).toBe('Synthetic handshake failure');
		await vi.advanceTimersByTimeAsync(3000); expect(state().error).toBeUndefined();
	});

	it('restores a maximum-size uncertain intent with JSON envelope and field-name overhead', async () => {
		const names = ['first', 'second', 'third', 'fourth'];
		host.list.mockImplementation(async () => { const next = catalog(); next.items[0].inputs = Object.fromEntries(names.map(name => [name, { input_type: 'opaque', required: true }])); return next; });
		await send({ type: 'refresh' }); host.start.mockRejectedValueOnce(new Error('Synthetic transport timeout'));
		const raw = '"' + 'x'.repeat(65534) + '"';
		await send({ type: 'start', workflowId: 'review', catalogRevision: state().catalogRevision, inputValues: Object.fromEntries(names.map(name => [name, raw])) });
		const original = host.start.mock.calls[0]; expect(state().pendingStart).toBeTruthy();
		currentPanel().dispose(); await open(); await send({ type: 'reconcile' });
		expect(host.start.mock.calls[1]).toEqual(original); expect(state().pendingStart).toBeUndefined();
	});
});
