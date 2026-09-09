/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ConversationStore } from './ConversationStore';

/** Keep chat available when durable history needs recovery, retaining the pending migration data. */
export async function activateConversationHistory(context: vscode.ExtensionContext): Promise<ConversationStore> {
	const store = new ConversationStore(context);
	context.subscriptions.push(store);
	const reportRecovery = (issue: { path: string; message: string }): void => {
		void vscode.window.showWarningMessage(vscode.l10n.t('A conversation could not be read. Its files are preserved at {0}. {1}', issue.path, issue.message));
	};
	context.subscriptions.push(store.onDidEncounterRecoveryIssue(reportRecovery));
	for (const issue of store.recoveryIssues) { reportRecovery(issue); }
	try { await store.ready; }
	catch (error) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Conversation history could not finish loading. Chat remains available and existing conversation data is preserved. Resolve the storage problem and restart to retry. {0}', error instanceof Error ? error.message : String(error)));
	}
	return store;
}
