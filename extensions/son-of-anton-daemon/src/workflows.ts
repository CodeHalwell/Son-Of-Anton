/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { NodeSession, WorkflowCommandError } from '@codypendent/protocol/node';
import { ensureDaemon, getRuntimeEndpoint } from './runtime.js';
import { parseWorkflowInputs, WORKFLOW_MAX_INPUT_FIELDS, WORKFLOW_MAX_TOTAL_INPUT_BYTES } from './workflowInputs.js';
import { renderWorkflowHtml, type WorkflowPanelState } from './workflowView.js';

type WorkflowReceipt = WorkflowPanelState['runs'][number];
interface PendingStart { workflowId: string; version: number; definitionDigest: string; inputs: Record<string, unknown>; key: string }
interface SavedWorkflows { runs: WorkflowReceipt[] }
interface WorkflowMessage {
	type?: string; version?: number; catalogRevision?: number; workflowId?: string;
	inputValues?: Record<string, string>; runId?: string; nodeId?: string;
}
const maximumReceipts = 20;
const maximumSnapshotNodes = 100;
const maximumPendingBytes = WORKFLOW_MAX_TOTAL_INPUT_BYTES + 64 * 1024;
const textIdentity = (value: string): boolean => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Remember only this product's launch receipts, never treating arbitrary pasted IDs as repository ownership. */
function restoreWorkflows(saved: SavedWorkflows | undefined): SavedWorkflows {
	const runs = Array.isArray(saved?.runs) ? saved.runs.filter(run => run && textIdentity(run.id) && textIdentity(run.workflowId)
		&& Number.isSafeInteger(run.version) && run.version >= 0).slice(0, maximumReceipts) : [];
	return { runs };
}

/** Pending payloads are protected separately from non-sensitive workflow receipt bookmarks. */
function restorePending(pending: PendingStart | undefined): PendingStart | undefined {
	if (pending && textIdentity(pending.workflowId) && Number.isSafeInteger(pending.version) && pending.version >= 0
		&& typeof pending.definitionDigest === 'string' && /^[\da-f]{64}$/.test(pending.definitionDigest)
		&& typeof pending.key === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(pending.key)
		&& pending.inputs && typeof pending.inputs === 'object' && !Array.isArray(pending.inputs)
		&& Object.keys(pending.inputs).length <= WORKFLOW_MAX_INPUT_FIELDS) {
		try { if (Buffer.byteLength(JSON.stringify(pending.inputs)) <= maximumPendingBytes) { return pending; } } catch { /* A damaged bookmark never becomes a launch request. */ }
	}
	return undefined;
}

/** Browse and control daemon-owned workflows without creating a second executor or a chat session. */
export function registerWorkflowCommands(context: vscode.ExtensionContext): void {
	const panels = new Set<vscode.WebviewPanel>();
	const scopes = new Map<string, Promise<vscode.WebviewPanel>>();
	let stopped = false;
	context.subscriptions.push({ dispose: () => { stopped = true; for (const panel of panels) { panel.dispose(); } panels.clear(); scopes.clear(); } });
	let nextVersion = 0;
	context.subscriptions.push(vscode.commands.registerCommand('sota.daemon.workflows', async () => {
		const folders = vscode.workspace.workspaceFolders ?? [];
		const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
		if (!folder || folder.uri.scheme !== 'file') { throw new Error(vscode.l10n.t('Open and select a local repository first.')); }
		const repository = await realpath(folder.uri.fsPath);
		const endpoint = getRuntimeEndpoint();
		const storageKey = `sota.daemon.workflows.${endpoint.identity}.${createHash('sha256').update(repository).digest('hex')}`;
		const existing = scopes.get(storageKey);
		if (existing) { const panel = await existing; if (panels.has(panel)) { panel.reveal(vscode.ViewColumn.Active); } return; }
		const opening = (async (): Promise<vscode.WebviewPanel> => {
			const saved = restoreWorkflows(context.workspaceState.get<SavedWorkflows>(storageKey));
			const secretKey = `${storageKey}.pending`;
			let pending: PendingStart | undefined;
			try {
				const raw = await context.secrets.get(secretKey);
				if (raw !== undefined) {
					if (Buffer.byteLength(raw) > maximumPendingBytes) { throw new Error(); }
					pending = restorePending(JSON.parse(raw));
					if (!pending) { throw new Error(); }
				}
			} catch { throw new Error(vscode.l10n.t('The protected pending workflow request could not be read. Reload this window before starting more work.')); }
			if (stopped) { throw new Error(vscode.l10n.t('The workflow view was closed.')); }
			const version = ++nextVersion;
			const state: WorkflowPanelState = { catalogRevision: 0, loading: true, busy: false, trusted: vscode.workspace.isTrusted,
				runs: saved.runs, selectedRunId: saved.runs[0]?.id, pendingStart: pending ? { workflowId: pending.workflowId } : undefined };
			const panel = vscode.window.createWebviewPanel('sota.workflowInspector', vscode.l10n.t('Workflows'), vscode.ViewColumn.Active,
				{ enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
			panels.add(panel);
			let disposed = false;
			let ready = false;
			let connected = false;
			let connecting: Promise<void> | undefined;
			let connectionVersion = 0;
			let reading = false;
			let errorOrigin: 'run' | 'other' | undefined;
			const publish = (): void => { if (!disposed && ready) { void panel.webview.postMessage({ type: 'state', version, state }); } };
			const checkEndpoint = (): void => {
				if (disposed || getRuntimeEndpoint().identity !== endpoint.identity) { throw new Error(vscode.l10n.t('The agent runtime connection changed. Close and reopen this workflow panel.')); }
			};
			const session = new NodeSession({ socketPath: endpoint.socketPath, clientName: 'son-of-anton-workflows',
				canWrite: () => !disposed && vscode.workspace.isTrusted && getRuntimeEndpoint().identity === endpoint.identity,
				onChange: () => {}, onError: () => { connected = false; } });
			const persist = async (): Promise<void> => {
				try { await context.workspaceState.update(storageKey, { runs: state.runs } satisfies SavedWorkflows); }
				catch { throw new Error(vscode.l10n.t('The workflow receipt could not be saved. Its protected start request remains available for reconciliation.')); }
			};
			const protectPending = async (request: PendingStart): Promise<void> => {
				try {
					const serialized = JSON.stringify(request);
					if (Buffer.byteLength(serialized) > maximumPendingBytes) { throw new Error(); }
					await context.secrets.store(secretKey, serialized);
				}
				catch { throw new Error(vscode.l10n.t('The workflow start request could not be stored securely. This attempt was not sent.')); }
			};
			const clearPending = async (): Promise<void> => {
				try { await context.secrets.delete(secretKey); }
				catch { throw new Error(vscode.l10n.t('The protected workflow request could not be cleared. Reconcile it before starting more work.')); }
				pending = undefined; state.pendingStart = undefined;
			};
			const ensureConnected = async (observe?: (version: number) => void): Promise<void> => {
				checkEndpoint();
				if (connected) { observe?.(connectionVersion); return; }
				if (connecting) { observe?.(connectionVersion); return connecting; }
				const attempt = ++connectionVersion; observe?.(attempt);
				const connection = (async () => {
					await ensureDaemon(context, endpoint); checkEndpoint();
					if (attempt !== connectionVersion) { throw new Error(vscode.l10n.t('This workflow connection was superseded.')); }
					await session.connect(); checkEndpoint();
					if (attempt !== connectionVersion) { throw new Error(vscode.l10n.t('This workflow connection was superseded.')); }
					connected = true;
				})();
				connecting = connection;
				try { await connection; } finally { if (connecting === connection) { connecting = undefined; } }
			};
			const report = (error: Error, origin: 'run' | 'other' = 'other'): void => {
				if (!disposed) { state.error = error.message; errorOrigin = origin; publish(); }
			};
			const readRun = async (): Promise<void> => {
				const runId = state.selectedRunId;
				if (reading || disposed || !panel.visible || !runId || !state.runs.some(run => run.id === runId)) { return; }
				reading = true;
				let startedUnder = connectionVersion;
				try {
					await ensureConnected(attempt => { startedUnder = attempt; });
					const snapshot = await session.readWorkflowRun(runId);
					checkEndpoint();
					if (state.selectedRunId !== runId) { return; }
					if (snapshot.workflow_run_id !== runId) { throw new Error(vscode.l10n.t('The runtime returned a different workflow run.')); }
					state.snapshotTotalNodes = snapshot.nodes.length;
					state.snapshot = { ...snapshot, nodes: snapshot.nodes.slice(0, maximumSnapshotNodes) };
					if (errorOrigin === 'run') { state.error = undefined; errorOrigin = undefined; }
					state.lastReadAt = new Date().toISOString(); publish();
				} catch (error) {
					if (startedUnder === connectionVersion && state.selectedRunId === runId) { report(error instanceof Error ? error : new Error(String(error)), 'run'); }
				} finally { reading = false; }
			};
			const loadCatalog = async (): Promise<void> => {
				state.loading = true; state.error = undefined; const revision = ++state.catalogRevision; publish();
				try {
					await ensureConnected();
					const catalog = await session.listWorkflows(repository);
					checkEndpoint();
					if (revision !== state.catalogRevision) { return; }
					if (catalog.repository !== repository) { throw new Error(vscode.l10n.t('The workflow catalog does not match this repository. No workflow can be started.')); }
					state.catalog = catalog;
				} catch (error) { if (revision === state.catalogRevision) { state.catalog = undefined; throw error; } }
				finally { if (revision === state.catalogRevision) { state.loading = false; publish(); } }
			};
			const launch = async (request: PendingStart): Promise<void> => {
				await ensureConnected();
				await protectPending(request); checkEndpoint();
				let id: string;
				try { id = await session.startWorkflow(request.workflowId, request.inputs, repository, { idempotencyKey: request.key, expectedDefinitionDigest: request.definitionDigest }); }
				catch (error) {
					if (error instanceof WorkflowCommandError && error.definitiveRejection) {
						await clearPending();
						if (error.code === 'workflow.definition-changed') { state.catalog = undefined; state.catalogRevision++; }
					} else {
						state.notice = vscode.l10n.t('The start outcome is unknown. Reconcile the same request before starting another workflow.');
						connected = false;
					}
					throw error;
				}
				if (!textIdentity(id)) { throw new Error(vscode.l10n.t('The runtime did not return a workflow run identity. Reconcile the start request.')); }
				state.runs = [{ id, workflowId: request.workflowId, version: request.version }, ...state.runs.filter(run => run.id !== id)].slice(0, maximumReceipts);
				state.selectedRunId = id; state.snapshot = undefined; state.snapshotTotalNodes = undefined; state.lastReadAt = undefined;
				state.notice = vscode.l10n.t('Workflow started. Closing this panel leaves its durable work running.');
				await persist(); await clearPending(); checkEndpoint(); publish(); await readRun();
			};
			const listener = panel.webview.onDidReceiveMessage((message: WorkflowMessage) => {
				if (!message || message.version !== version || disposed) { return; }
				if (message.type === 'ready') { ready = true; publish(); return; }
				if (state.busy) { return; }
				state.busy = true; state.error = undefined; publish();
				void (async () => {
					checkEndpoint();
					if (message.type === 'refresh') { await loadCatalog(); await readRun(); return; }
					if (message.type === 'selectRun' && state.runs.some(run => run.id === message.runId)) {
						state.selectedRunId = message.runId; state.snapshot = undefined; state.snapshotTotalNodes = undefined; state.lastReadAt = undefined;
						publish(); await readRun(); return;
					}
					if (message.type === 'refreshRun') { await readRun(); return; }
					if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before starting or controlling a workflow.')); }
					if (message.type === 'start') {
						if (pending) { throw new Error(vscode.l10n.t('Reconcile the pending start request before starting another workflow.')); }
						if (state.loading || message.catalogRevision !== state.catalogRevision || state.catalog?.repository !== repository) { throw new Error(vscode.l10n.t('Refresh the workflow catalog before starting this workflow.')); }
						const entry = state.catalog.items.find(item => item.id === message.workflowId);
						if (!entry || !message.inputValues || typeof message.inputValues !== 'object' || Array.isArray(message.inputValues)
							|| Object.values(message.inputValues).some(value => typeof value !== 'string')) { throw new Error(vscode.l10n.t('Choose a listed workflow and enter its declared inputs.')); }
						const result = parseWorkflowInputs(entry.inputs, message.inputValues);
						if (!result.ok) {
							const errors = { required: vscode.l10n.t('Input {0} is required.', result.field ?? ''), 'invalid-json': vscode.l10n.t('Input {0} must be valid JSON.', result.field ?? ''),
								'unknown-input': vscode.l10n.t('Input {0} is not declared by this workflow.', result.field ?? ''), 'too-large': vscode.l10n.t('Workflow inputs exceed the supported size limit.'),
								'too-many': vscode.l10n.t('This workflow has more inputs than this panel supports.') };
							throw new Error(errors[result.reason]);
						}
						if (!/^[\da-f]{64}$/.test(entry.definition_digest)) { throw new Error(vscode.l10n.t('The workflow catalog has no valid definition identity. Refresh it before starting.')); }
						pending = { workflowId: entry.id, version: entry.version, definitionDigest: entry.definition_digest, inputs: result.inputs, key: randomUUID() };
						state.pendingStart = { workflowId: pending.workflowId }; await launch(pending); return;
					}
					if (message.type === 'reconcile') { if (pending) { await launch(pending); } return; }
					const runId = message.runId;
					if (!runId || runId !== state.selectedRunId || !state.runs.some(run => run.id === runId)) { return; }
					await ensureConnected();
					if (message.type === 'pause') { await session.pauseWorkflow(runId); state.notice = vscode.l10n.t('Pause requested. In-flight nodes may finish before the workflow pauses.'); }
					else if (message.type === 'resume') { await session.resumeWorkflow(runId); state.notice = vscode.l10n.t('Resume requested.'); }
					else if (message.type === 'cancel') { await session.cancelWorkflow(runId); state.notice = vscode.l10n.t('Cancellation requested. Refresh the run to observe its recorded outcome.'); }
					else if (message.type === 'retry' && state.snapshot?.workflow_run_id === runId && state.snapshot.nodes.some(node => node.node_id === message.nodeId)) {
						await session.retryWorkflowNode(runId, message.nodeId!); state.notice = vscode.l10n.t('Retry requested for the selected node and its downstream nodes.');
					}
					checkEndpoint(); await readRun();
				})().catch(report).finally(() => { state.busy = false; state.trusted = vscode.workspace.isTrusted; publish(); });
			});
			const poll = setInterval(() => { if (!state.busy) { void readRun().catch(report); } }, 3000);
			const visibility = panel.onDidChangeViewState(() => { if (panel.visible && !state.busy) { void readRun().catch(report); } });
			const trust = vscode.workspace.onDidGrantWorkspaceTrust(() => {
				connected = false; connecting = undefined; connectionVersion++; session.disconnect(); state.trusted = true; void loadCatalog().catch(report);
			});
			const disposal = panel.onDidDispose(() => {
				disposed = true; panels.delete(panel); scopes.delete(storageKey); clearInterval(poll); listener.dispose(); visibility.dispose(); trust.dispose(); disposal.dispose(); session.disconnect();
			});
			panel.webview.html = renderWorkflowHtml({ nonce: randomBytes(24).toString('hex'), version, repository, endpointIdentity: endpoint.identity,
				localize: (text, ...args) => vscode.l10n.t(text, ...args) });
			void loadCatalog().then(() => readRun()).catch(report);
			return panel;
		})();
		scopes.set(storageKey, opening);
		try { await opening; } catch (error) { if (scopes.get(storageKey) === opening) { scopes.delete(storageKey); } throw error; }
	}));
}
