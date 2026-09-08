/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ConversationStore, type ConversationRecord } from './ConversationStore';

type ConversationTarget = string | { readonly summary: { readonly id: string } } | undefined;

/** Shared conversation actions for the palette, history tree, and chat webviews. */
export class ConversationActions {
	private readonly pendingDeletes = new Set<string>();

	constructor(private readonly store: ConversationStore) {}

	create(sourceId?: string): ConversationRecord {
		const source = sourceId ? this.store.load(sourceId) : this.store.getInitialConversation();
		const fresh = this.store.create();
		if (source?.summary.lastModel) {
			this.store.update(fresh.summary.id, [], undefined, undefined, undefined, source.summary.lastModel);
		}
		return this.store.load(fresh.summary.id) ?? fresh;
	}

	async rename(target?: ConversationTarget): Promise<void> {
		const record = this.resolve(target);
		if (!record) { return; }
		const title = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Rename Conversation'),
			value: record.summary.title,
			validateInput: value => value.trim() ? undefined : vscode.l10n.t('Title cannot be empty.'),
		});
		if (title !== undefined) { this.store.rename(record.summary.id, title); }
	}

	async delete(target?: ConversationTarget): Promise<void> {
		const record = this.resolve(target);
		if (!record || this.pendingDeletes.has(record.summary.id)) { return; }
		const id = record.summary.id;
		this.pendingDeletes.add(id);
		try {
			const action = vscode.l10n.t('Delete');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('Delete conversation "{0}"? This cannot be undone.', record.summary.title),
				{ modal: true }, action,
			);
			if (choice === action) { this.store.delete(id); }
		} finally { this.pendingDeletes.delete(id); }
	}

	private resolve(target: ConversationTarget): ConversationRecord | undefined {
		const id = typeof target === 'string' ? target : target?.summary?.id;
		return target === undefined ? this.store.getInitialConversation() : typeof id === 'string' && id ? this.store.load(id) : undefined;
	}
}
