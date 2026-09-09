/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ConversationStore } from './ConversationStore';

/** Register usable in-memory history immediately while durable migration settles in the background. */
export function activateConversationHistory(context: vscode.ExtensionContext): ConversationStore {
	const store = new ConversationStore(context);
	context.subscriptions.push(store);
	let disposed = false;
	context.subscriptions.push({ dispose: () => { disposed = true; } });
	const warn = (message: string): void => {
		if (disposed) { return; }
		try { void Promise.resolve(vscode.window.showWarningMessage(message)).catch(() => {}); }
		catch { /* A closing host must not turn a recovery notification into an unhandled rejection. */ }
	};
	const reportRecovery = (issue: { path: string; message: string }): void => {
		warn(vscode.l10n.t('A conversation could not be read. Its files are preserved at {0}. {1}', issue.path, issue.message));
	};
	context.subscriptions.push(store.onDidEncounterRecoveryIssue(reportRecovery));
	for (const issue of store.recoveryIssues) { reportRecovery(issue); }
	void store.ready.catch(error => {
		warn(vscode.l10n.t('Conversation history could not finish loading. Chat remains available and existing conversation data is preserved. Resolve the storage problem and restart to retry. {0}', error instanceof Error ? error.message : String(error)));
	});
	return store;
}
