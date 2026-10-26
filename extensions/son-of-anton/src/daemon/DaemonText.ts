/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { NodeSession, type NodeSessionOptions } from '@codypendent/protocol/node';
import type { LlmRequestOptions } from 'son-of-anton-core/llm/LlmClient';

/** Short editor requests still execute through the daemon's policy/model path.
 * Each uses an internal, durable session so completions never pollute a chat.
 */
export async function requestDaemonText(options: LlmRequestOptions,
	createSession: (options: NodeSessionOptions) => NodeSession = options => new NodeSession(options)): Promise<string> {
	if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before requesting an edit or completion.')); }
	const folder = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
		|| vscode.workspace.workspaceFolders?.[0];
	if (!folder || folder.uri.scheme !== 'file') { throw new Error(vscode.l10n.t('Open a local repository before requesting an edit or completion.')); }
	const prompt = [options.systemPrompt, ...options.messages.map(message => `${message.role}: ${message.content}`)].filter(Boolean).join('\n\n');
	if (!prompt.trim() || prompt.length > 100_000) { throw new Error(vscode.l10n.t('The inline context is too large. Select a smaller block.')); }
	const aborted = (): Error => new Error(vscode.l10n.t('The editor request was cancelled.'));
	if (options.signal?.aborted) { throw aborted(); }
	await vscode.commands.executeCommand('sota.daemon.ensure');
	if (options.signal?.aborted) { throw aborted(); }
	let runId: string | undefined;
	let terminal = false;
	let failure: Error | undefined;
	let cancelled = false;
	let cancelling: Promise<void> | undefined;
	let wake = (): void => {};
	const session = createSession({ clientName: 'son-of-anton-inline', canWrite: () => vscode.workspace.isTrusted,
		socketPath: vscode.workspace.getConfiguration('sota.daemon').get<string>('socketPath') || undefined,
		onChange: () => wake(), onError: () => {} });
	const cancelAcceptedRun = async (): Promise<void> => {
		if (runId) { cancelling ??= session.cancelRun(runId); await cancelling; }
	};
	const cancel = (): void => {
		cancelled = true; wake();
		if (runId) { void cancelAcceptedRun().catch(() => {}); }
	};
	options.signal?.addEventListener('abort', cancel, { once: true });
	const deadline = setTimeout(() => { failure = new Error(vscode.l10n.t('The editor request timed out.')); cancel(); }, 120_000);
	try {
		await session.connect();
		if (cancelled || options.signal?.aborted) { throw aborted(); }
		await session.createSession(vscode.l10n.t('Editor assistance'), randomUUID(), realpathSync(folder.uri.fsPath), { internal: true });
		if (cancelled || options.signal?.aborted) { throw aborted(); }
		const model = options.model.startsWith('daemon:') && options.model !== 'daemon:default' ? decodeURIComponent(options.model.slice(7)) : undefined;
		runId = await session.submit(prompt, 'Ask', { model, idempotencyKey: randomUUID() });
		if (!runId) { throw new Error(vscode.l10n.t('The daemon did not return an inline run identity.')); }
		if (cancelled || options.signal?.aborted) { await cancelAcceptedRun(); throw failure ?? aborted(); }
		await new Promise<void>((resolve, reject) => {
			wake = () => {
				const run = session.snapshot.projection.runs?.find(item => item.id === runId);
				terminal = !!run && ['Completed', 'Cancelled', 'Failed'].includes(run.state);
				if (failure || cancelled) { reject(failure ?? aborted()); }
				else if (run?.disposition?.type === 'Failed') { reject(new Error(run.disposition.reason)); }
				else if (run?.state === 'Cancelled') { reject(aborted()); }
				else if (run?.state === 'Completed') { resolve(); }
				else if (['closed', 'history-unavailable'].includes(session.snapshot.status)) { reject(new Error(vscode.l10n.t('The inline transcript could not be restored.'))); }
			};
			wake();
		});
		// Read the reconstructed ledger projection, including any replayed deltas.
		// Never apply a truncated completion after a reconnect or a size cap.
		const projection = session.snapshot.projection;
		const replies = projection.rows.filter(row => row.kind === 'assistant' && (row.runId === runId || row.id === `${runId}:reply`));
		if (projection.historyTruncated || !replies.length) { throw new Error(vscode.l10n.t('The inline response is incomplete or too large. Request a smaller edit.')); }
		return replies.map(row => row.text).join('');
	} finally {
		clearTimeout(deadline); options.signal?.removeEventListener('abort', cancel);
		// An explicit inline cancellation cancels its own run. A broken socket
		// never claims success or closes an outcome that could not be reconciled.
		if (runId && !terminal && (cancelled || failure)) { await cancelAcceptedRun().catch(() => {}); }
		if (session.snapshot.sessionId && (!runId || terminal)) { await session.closeSession().catch(() => {}); }
		session.disconnect();
	}
}
