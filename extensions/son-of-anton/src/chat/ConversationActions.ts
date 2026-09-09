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

	constructor(private readonly store: ConversationStore, private readonly checkpointAt?: (conversationId: string, messageCount: number) => string | undefined, private readonly retainCheckpoint?: (checkpointId: string, branchId: string) => Promise<void>, private readonly dropCheckpoint?: (branchId: string) => Promise<void>) {}

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
			const action = vscode.l10n.t('Move to Trash');
			const choice = await vscode.window.showWarningMessage(
				vscode.l10n.t('Move conversation "{0}" to Trash? You can restore it from Manage Conversation History.', record.summary.title),
				{ modal: true }, action,
			);
			if (choice === action) { this.store.delete(id); }
		} finally { this.pendingDeletes.delete(id); }
	}

	pin(target?: ConversationTarget): void { const record = this.resolve(target); if (record) { this.store.setPinned(record.summary.id, !record.summary.pinned); } }
	archive(target?: ConversationTarget): void { const record = this.resolve(target); if (record) { this.store.archive(record.summary.id, !record.summary.archived); } }
	restore(target: ConversationTarget): void { const id = typeof target === 'string' ? target : target?.summary.id; if (id) { this.store.restore(id); } }

	async branch(target?: ConversationTarget, throughMessageIndex?: number): Promise<ConversationRecord | undefined> {
		const record = this.resolve(target); if (!record?.messages.length) { return undefined; }
		let index = throughMessageIndex;
		if (index === undefined) {
			const choices = record.messages.flatMap((message, messageIndex) => {
				if (message.role !== 'user' && message.role !== 'assistant') { return []; }
				const content = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.text : '').join(' ');
				return [{ label: `${messageIndex + 1}. ${content.slice(0, 90).replace(/\s+/g, ' ')}`, description: message.role, messageIndex }];
			});
			index = (await vscode.window.showQuickPick(choices, { title: vscode.l10n.t('Branch Conversation'), placeHolder: vscode.l10n.t('Choose the last message to include. Files will stay in their current state.') }))?.messageIndex;
		}
		if (index === undefined) { return undefined; }
		const checkpointId = this.retainCheckpoint && this.dropCheckpoint ? this.checkpointAt?.(record.summary.id, index + 1) : undefined;
		const branch = this.store.branch(record.summary.id, index, { checkpointId, workspaceState: checkpointId ? 'checkpoint-available' : 'unlinked' });
		if (branch) {
			try {
				if (checkpointId) { await this.retainCheckpoint!(checkpointId, branch.summary.id); }
				await this.store.flush();
			} catch (error) {
				const recoveryErrors: unknown[] = [];
				// Preserve the transcript as an explicitly unlinked recovery copy, even
				// while its disk remains full. Releasing this branch's ownership must
				// still run if updating that pending metadata throws (and vice versa).
				for (const recover of [
					() => this.store.unlinkBranchCheckpoint(branch.summary.id),
					() => checkpointId ? this.dropCheckpoint!(branch.summary.id) : undefined,
					() => this.store.flush(),
				]) {
					try { await recover(); } catch (recoveryError) { recoveryErrors.push(recoveryError); }
				}
				if (recoveryErrors.length) {
					const describe = (value: unknown) => value instanceof Error ? value.message : String(value);
					throw new AggregateError([error, ...recoveryErrors], vscode.l10n.t('Branch creation failed: {0}. Recovery also failed: {1}', describe(error), recoveryErrors.map(describe).join('; ')));
				}
				throw error;
			}
		}
		return branch;
	}

	/** Compare rendered responses and recorded file/tool changes in the native diff editor. */
	async compare(target?: ConversationTarget): Promise<void> {
		const right = this.resolve(target); if (!right) { return; }
		let left = right.summary.branch ? this.store.load(right.summary.branch.parentId, true) : undefined;
		if (!left) {
			const picked = await vscode.window.showQuickPick(this.store.search({ scope: 'all', limit: Number.MAX_SAFE_INTEGER }).items.filter(summary => summary.id !== right.summary.id).map(summary => ({ label: summary.title, description: summary.workspaceName, summary })), { title: vscode.l10n.t('Compare Conversations'), placeHolder: vscode.l10n.t('Choose a conversation to compare against the current response history') });
			left = picked ? this.store.load(picked.summary.id, true) : undefined;
		}
		if (!left) { return; }
		const { exportConversationAsMarkdown } = await import('./ConversationExporter');
		const leftDocument = await vscode.workspace.openTextDocument({ content: exportConversationAsMarkdown(left, { includeTimestamps: false, includeMetadata: false }), language: 'markdown' });
		const rightDocument = await vscode.workspace.openTextDocument({ content: exportConversationAsMarkdown(right, { includeTimestamps: false, includeMetadata: false }), language: 'markdown' });
		await vscode.commands.executeCommand('vscode.diff', leftDocument.uri, rightDocument.uri, vscode.l10n.t('{0} ↔ {1}', left.summary.title, right.summary.title), { preview: true });
	}

	/** Palette fallback exposes every history operation even when a webview is closed. */
	async manage(): Promise<void> {
		const view = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Active Conversations'), scope: 'active' as const },
			{ label: vscode.l10n.t('Archived Conversations'), scope: 'archived' as const },
			{ label: vscode.l10n.t('Trash'), scope: 'trash' as const },
		], { title: vscode.l10n.t('Manage Conversation History') });
		if (!view) { return; }
		const query = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Search conversation titles and messages (leave empty for all)') });
		if (query === undefined) { return; }
		const matches = await this.store.searchAsync({ scope: view.scope, query, limit: Number.MAX_SAFE_INTEGER });
		const picked = await vscode.window.showQuickPick(matches.items.map(summary => ({ label: `${summary.pinned ? '$(pin) ' : ''}${summary.title}`, description: summary.workspaceName, detail: vscode.l10n.t('{0} messages', summary.messageCount), summary })), { title: vscode.l10n.t('Conversation History'), matchOnDescription: true });
		if (!picked) { return; }
		if (view.scope === 'trash') {
			const action = await vscode.window.showQuickPick([vscode.l10n.t('Restore'), vscode.l10n.t('Delete Permanently')]);
			if (action === vscode.l10n.t('Restore')) { this.store.restore(picked.summary.id); }
			if (action === vscode.l10n.t('Delete Permanently')) {
				const confirmed = await vscode.window.showWarningMessage(vscode.l10n.t('Permanently delete "{0}" and its retained conversation data? This cannot be undone.', picked.summary.title), { modal: true }, vscode.l10n.t('Delete Permanently'));
				if (confirmed) { this.store.permanentDelete(picked.summary.id); }
			}
		} else {
			const action = await vscode.window.showQuickPick([
				{ label: vscode.l10n.t('Open'), actionId: 'open' }, { label: picked.summary.pinned ? vscode.l10n.t('Unpin') : vscode.l10n.t('Pin'), actionId: 'pin' },
				{ label: view.scope === 'archived' ? vscode.l10n.t('Unarchive') : vscode.l10n.t('Archive'), actionId: 'archive' },
				{ label: vscode.l10n.t('Branch'), actionId: 'branch' }, { label: vscode.l10n.t('Compare'), actionId: 'compare' }, { label: vscode.l10n.t('Move to Trash'), actionId: 'trash' },
			]);
			if (action?.actionId === 'open') { await vscode.commands.executeCommand('sota.openConversation', picked.summary.id); }
			if (action?.actionId === 'compare') { await this.compare(picked); }
			if (action?.actionId === 'pin') { this.pin(picked); }
			if (action?.actionId === 'archive') { this.archive(picked); }
			if (action?.actionId === 'trash') { await this.delete(picked); }
			if (action?.actionId === 'branch') { const branch = await this.branch(picked); if (branch) { await vscode.commands.executeCommand('sota.openConversation', branch.summary.id); } }
		}
		await this.store.flush();
	}

	private resolve(target: ConversationTarget): ConversationRecord | undefined {
		const id = typeof target === 'string' ? target : target?.summary?.id;
		return target === undefined ? this.store.getInitialConversation() : typeof id === 'string' && id ? this.store.load(id) : undefined;
	}
}
