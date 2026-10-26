/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { NodeSession } from '@codypendent/protocol/node';
import type { Payload } from '@codypendent/protocol';
type BlackboardItemView = Extract<Payload, { type: 'BlackboardItems' }>['items'][number];
import { ensureDaemon } from './runtime.js';
import { renderBoardHtml } from './html.js';

/** A repository board is a durable daemon projection, shared with both native clients. */
export async function openBoard(context: vscode.ExtensionContext): Promise<void> {
	const folders = vscode.workspace.workspaceFolders ?? [];
	const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
	if (!folder || folder.uri.scheme !== 'file') { return; }
	const repository = await realpath(folder.uri.fsPath);
	await ensureDaemon(context);
	const panel = vscode.window.createWebviewPanel('sota.sharedBoard', vscode.l10n.t('Shared Task Board'), vscode.ViewColumn.Active,
		{ enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
	let disposed = false;
	let busy = false;
	let items: BlackboardItemView[] = [];
	const scope = { type: 'RepositoryBoard' as const, repository };
	const session = new NodeSession({ clientName: 'son-of-anton-board', canWrite: () => vscode.workspace.isTrusted,
		socketPath: vscode.workspace.getConfiguration('sota.daemon').get<string>('socketPath') || undefined,
		onChange: () => {}, onError: error => { if (!disposed) { void panel.webview.postMessage({ type: 'error', error }); } } });
	const refresh = async (): Promise<void> => {
		const reply = await session.readService({ type: 'ReadBlackboard', workflow_run_id: '', board_repository: repository, include_superseded: false });
		if (disposed || reply.type !== 'BlackboardItems') { return; }
		const tasks = reply.items.filter(item => item.kind === 'task');
		items = tasks.slice(0, 1000);
		void panel.webview.postMessage({ type: 'board', repository, items, trusted: vscode.workspace.isTrusted,
			truncation: tasks.length > items.length ? vscode.l10n.t('Showing {0} of {1} tasks. Open Codypendent to inspect the full board.', items.length, tasks.length) : '' });
	};
	const perform = async (action: () => Promise<void>): Promise<void> => {
		if (disposed || busy) { return; }
		busy = true;
		try { await action(); }
		catch (error) { if (!disposed) { void panel.webview.postMessage({ type: 'error', error: String(error) }); } }
		finally { busy = false; }
	};
	const timer = setInterval(() => { void perform(refresh); }, 3000);
	const subscriptions = [panel.webview.onDidReceiveMessage((message: unknown) => {
		if (!message || typeof message !== 'object' || !('type' in message)) { return; }
		const request = message as { type: unknown; id?: unknown };
		void perform(async () => {
			if (request.type === 'ready' || request.type === 'refresh') { await refresh(); return; }
			if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before changing the board.')); }
			if (request.type === 'add') {
				const title = await vscode.window.showInputBox({ title: vscode.l10n.t('New Shared Task'), prompt: vscode.l10n.t('Task title'), validateInput: value => value.length > 1000 ? vscode.l10n.t('Use at most 1,000 characters.') : undefined });
				if (!title?.trim() || disposed) { return; }
				await session.writeBoard({ type: 'PostBlackboardItem', scope, item: { kind: 'task', payload: { title: title.trim() }, status: 'todo' } }, { idempotencyKey: randomUUID() });
			} else if (request.type === 'move' || request.type === 'assign') {
				const item = items.find(item => item.id === request.id);
				if (!item) { throw new Error(vscode.l10n.t('The board changed. Refresh before editing this task.')); }
				const status = request.type === 'move' ? await vscode.window.showQuickPick([
					{ label: vscode.l10n.t('To do'), value: 'todo' }, { label: vscode.l10n.t('In progress'), value: 'doing' },
					{ label: vscode.l10n.t('Review'), value: 'review' }, { label: vscode.l10n.t('Done'), value: 'done' }], { title: vscode.l10n.t('Move Shared Task') }) : undefined;
				const assignee = request.type === 'assign' ? await vscode.window.showInputBox({ title: vscode.l10n.t('Assign Shared Task'), value: item.assignee ?? '', validateInput: value => value.length > 200 ? vscode.l10n.t('Use at most 200 characters.') : undefined }) : undefined;
				if (disposed || request.type === 'move' && !status || request.type === 'assign' && assignee === undefined) { return; }
				await session.writeBoard({ type: 'UpdateBlackboardItem', scope, item_id: item.id, status: status?.value, assignee }, { idempotencyKey: randomUUID() });
			} else { return; }
			await refresh();
		});
	}), vscode.workspace.onDidGrantWorkspaceTrust(() => { void perform(async () => { await session.connect(); await refresh(); }); })];
	panel.onDidDispose(() => { disposed = true; clearInterval(timer); session.disconnect(); subscriptions.forEach(item => item.dispose()); });
	const nonce = randomBytes(24).toString('hex');
	panel.webview.html = renderBoardHtml({ nonce, cspSource: panel.webview.cspSource,
		style: panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media/session.css')).toString(), localize: text => vscode.l10n.t(text) });
	await perform(async () => { await session.connect(); await refresh(); });
}
