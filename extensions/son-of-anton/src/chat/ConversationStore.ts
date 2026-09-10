/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ConversationDeletedError, ConversationStorage, type ConversationRecoveryIssue } from './ConversationStorage';
import { attachConversationWriteToken, type ConversationWriteToken } from './ConversationWriteToken';
export type { ConversationWriteToken } from './ConversationWriteToken';
import { watchConversationLifecycle } from './ConversationLifecycleWatcher';
import { conversationTextChunks, MAX_HISTORY_QUERY_LENGTH } from './ConversationSearchIndex';
import { ChatMessage } from './ChatPanel';
import { AgentHandle } from 'son-of-anton-core/agents/types';
import { ChatMode } from 'son-of-anton-core/agents/agentEvents';
import type { ModelId } from 'son-of-anton-core/llm/LlmClient';

/**
 * Maximum length of an auto-derived conversation title. Titles are derived
 * from the first user message; longer messages are truncated with an ellipsis
 * suffix so the sidebar tree stays readable.
 */
const MAX_TITLE_LENGTH = 50;

const ACTIVE_KEY = 'sota.conversations.active';

const INDEX_KEY = 'sota.conversations.index';
const RECORD_PREFIX = 'sota.conversations.';
const LEGACY_CONVERSATION_KEY = 'sota.chatHistory';
const MIGRATION_FLAG_KEY = 'sota.conversations.migrated';

/**
 * Tab identifiers used by the chat sidebar's top tab bar. Persisted on the
 * conversation summary so the active tab is restored when the user switches
 * between conversations. Legacy conversations without an entry default to
 * `'chat'` — the same surface they always saw.
 */
export type ChatTab = 'chat' | 'tasks' | 'history' | 'settings' | 'roster';

/**
 * Lightweight summary of a conversation surfaced in the history sidebar. The
 * message body lives in a separate per-conversation key so listing N
 * conversations does not require reading N message arrays.
 */
export interface ConversationSummary {
	readonly id: string;
	/** Auto-generated from the first user message; capped at {@link MAX_TITLE_LENGTH} chars. */
	readonly title: string;
	/** Milliseconds since epoch. */
	readonly createdAt: number;
	/** Milliseconds since epoch — updated on every `update()`. */
	readonly updatedAt: number;
	readonly messageCount: number;
	/** Last specialist that authored a turn in this conversation, if any. */
	readonly lastSpecialist?: AgentHandle | 'anton';
	/**
	 * Last Cline-style chat mode the user set in this conversation. Persists
	 * across reloads so flipping into Plan mode in one conversation doesn't
	 * silently leak into another. Defaults to `'act'` when undefined (legacy
	 * conversations created before Phase 58 land here).
	 */
	readonly lastMode?: ChatMode;
	/**
	 * Last chat sidebar tab the user activated in this conversation. Persists
	 * across reloads so flipping to the Roster or Tasks tab in one
	 * conversation doesn't follow the user into another. Defaults to
	 * `'chat'` when undefined (every legacy summary lands here).
	 */
	readonly lastTab?: ChatTab;
	readonly lastModel?: ModelId;
	/** Absent on older conversations whose original workspace is unknown. */
	readonly workspaceId?: string;
	readonly workspaceName?: string;
	readonly pinned?: boolean;
	readonly archived?: boolean;
	readonly deletedAt?: number;
	readonly branch?: { readonly parentId: string; readonly throughMessageIndex: number; readonly checkpointId?: string; readonly workspaceState: 'checkpoint-available' | 'unlinked' };
}

/**
 * A complete conversation record: summary metadata plus the full message
 * scrollback. Returned by `load()` when the host wants to restore a session.
 */
export interface ConversationRecord {
	readonly writeToken?: ConversationWriteToken;
	readonly summary: ConversationSummary;
	readonly messages: ChatMessage[];
}

export interface ConversationSearchOptions { query?: string; scope?: 'active' | 'archived' | 'trash' | 'all'; workspaceOnly?: boolean; offset?: number; limit?: number }
export interface ConversationSearchResult { items: ConversationSummary[]; total: number; nextOffset?: number }

/**
 * Generate a v4-shape UUID without pulling in the `crypto` library — works
 * in the Node 22 extension host without additional dependencies. The
 * collision domain is per-install so an RFC4122-compliant id is overkill;
 * any 128-bit random value is fine.
 */
function generateId(): string {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Math.floor(Math.random() * 256);
	}
	// Variant + version bits per RFC 4122 §4.4 so the id at least *looks* like
	// a UUID v4 to any tools that pattern-match on it.
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Derive a human-readable title from a sequence of chat messages. Picks the
 * first user message and trims it to {@link MAX_TITLE_LENGTH}. Returns
 * `undefined` if no user message exists yet, signalling the placeholder
 * title should be retained.
 */
function deriveTitle(messages: ReadonlyArray<ChatMessage>): string | undefined {
	const firstUser = messages.find(m => m.role === 'user');
	if (!firstUser) {
		return undefined;
	}
	// Structured content (image attachments) is flattened to the first text
	// part so the title still reads as the user's typed prose. Falls back to
	// a generic placeholder when only image parts are present.
	let raw: string;
	if (typeof firstUser.content === 'string') {
		raw = firstUser.content;
	} else {
		const firstText = firstUser.content.find(p => p.type === 'text');
		raw = firstText && firstText.type === 'text' ? firstText.text : '(image attachment)';
	}
	const trimmed = raw.trim().replace(/\s+/g, ' ');
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.length <= MAX_TITLE_LENGTH) {
		return trimmed;
	}
	return `${trimmed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function recordKey(id: string): string {
	return `${RECORD_PREFIX}${id}`;
}

/**
 * Persists conversation manifests and immutable message pages in extension storage.
 * Listing reads only metadata; bodies are loaded on demand, and writes are
 * serialized without imposing retention limits. Memento storage is retained
 * for migration and hosts without a local storage URI.
 *
 * Includes a one-shot migration from the legacy single-conversation key
 * (`sota.chatHistory`, workspaceState) so users upgrading don't lose their
 * existing scrollback — see the constructor.
 */
export class ConversationStore implements vscode.Disposable {
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange: vscode.Event<void> = this._onDidChange.event;
	private readonly _onDidDelete = new vscode.EventEmitter<string>();
	readonly onDidDelete: vscode.Event<string> = this._onDidDelete.event;
	private readonly _onDidChangeActive = new vscode.EventEmitter<string>();
	readonly onDidChangeActive: vscode.Event<string> = this._onDidChangeActive.event;
	private readonly _onDidEncounterRecoveryIssue = new vscode.EventEmitter<ConversationRecoveryIssue>();
	readonly onDidEncounterRecoveryIssue = this._onDidEncounterRecoveryIssue.event;
	private readonly encounteredRecoveryIssues = new Map<string, ConversationRecoveryIssue>();
	/** Initial scan issues are retained because the host subscribes after construction. */
	get recoveryIssues(): ReadonlyArray<ConversationRecoveryIssue> { return [...this.encounteredRecoveryIssues.values()]; }

	private readonly disk: ConversationStorage | undefined;
	private readonly searchLifetime = new AbortController();
	private readonly pendingRecords = new Map<string, ConversationRecord | null>();
	private readonly pendingTokenForks = new WeakMap<ConversationRecord, Set<ConversationWriteToken>>();
	private pendingWrite: Promise<void> = Promise.resolve();
	private writeFailure: Error | undefined;
	private readonly failedWrites = new Map<string, Error>();
	readonly ready: Promise<void>;
	private readonly _onDidPermanentlyDelete = new vscode.EventEmitter<string>();
	readonly onDidPermanentlyDelete = this._onDidPermanentlyDelete.event;
	private permanentDeleteCleanup?: (id: string) => Promise<void>;
	private lifecycleWatcher?: vscode.Disposable;
	private disposed = false;
	private scanQueued = false;
	private scanRequested = false;
	private readonly observedDeletions = new Set<string>();
	private readonly deletionNotifications = new Set<string>();
	private readonly cleanupScheduled = new Set<string>();
	private readonly failedDeletionCleanups = new Set<string>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly workspaceId = vscode.workspace.workspaceFile?.toString() ?? JSON.stringify((vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()).sort()),
		private readonly workspaceName = vscode.workspace.name ?? vscode.l10n.t('Empty Window'),
	) {
		this.disk = context.globalStorageUri?.scheme === 'file' ? new ConversationStorage(path.join(context.globalStorageUri.fsPath, 'conversations-v2'), issue => this.reportRecoveryIssue(issue)) : undefined;
		if (this.disk && typeof vscode.workspace.createFileSystemWatcher === 'function' && typeof vscode.RelativePattern === 'function') {
			this.lifecycleWatcher = watchConversationLifecycle(path.join(context.globalStorageUri.fsPath, 'conversations-v2'), () => this.scanDeletions());
		}
		this.scanDeletions();
		const oldIndex = context.globalState.get<ConversationSummary[]>(INDEX_KEY) ?? [];
		const retainedLegacyIds = new Set<string>();
		if (this.disk) {
			this.disk.list(); // Scan for recoverable damage without preventing activation.
			for (const summary of oldIndex) {
				try {
					if (!this.disk.isPermanentlyDeleted(summary.id) && this.disk.isHidden(summary.id)) { retainedLegacyIds.add(summary.id); continue; }
					if (!this.disk.isPermanentlyDeleted(summary.id) && !this.disk.load(summary.id)) {
						const messages = context.globalState.get<ChatMessage[]>(recordKey(summary.id)) ?? [];
						this.persist({ summary: { ...summary, messageCount: messages.length }, messages });
					}
				} catch { retainedLegacyIds.add(summary.id); } // Never overwrite damage or discard its original migration source.
			}
		}
		const legacy = !context.workspaceState.get<boolean>(MIGRATION_FLAG_KEY) ? context.workspaceState.get<ChatMessage[]>(LEGACY_CONVERSATION_KEY) : undefined;
		let retainWorkspaceLegacy = false;
		if (Array.isArray(legacy) && legacy.length) {
			// A stable import ID makes retrying a failed migration idempotent.
			const id = createHash('sha256').update(this.workspaceId).update(JSON.stringify(legacy)).digest('hex');
			try {
				if (!this.disk?.isPermanentlyDeleted(id) && this.isHidden(id)) { retainWorkspaceLegacy = true; }
				else if (!this.disk?.isPermanentlyDeleted(id) && !this.load(id, true)) {
					const now = Date.now();
					this.persist({ summary: { id, title: deriveTitle(legacy) ?? 'Imported conversation', createdAt: now, updatedAt: now, messageCount: legacy.length, workspaceId: this.workspaceId, workspaceName: this.workspaceName }, messages: [...legacy] });
				}
			} catch { retainWorkspaceLegacy = true; }
		}
		this.ready = this.flush().then(async () => {
			try {
				await this.disk?.cleanupDeleted();
				// Source records are cleared only after every destination manifest is durable.
				if (this.disk) {
					for (const summary of oldIndex) { if (!retainedLegacyIds.has(summary.id)) { await context.globalState.update(recordKey(summary.id), undefined); } }
					await context.globalState.update(INDEX_KEY, retainedLegacyIds.size ? oldIndex.filter(summary => retainedLegacyIds.has(summary.id)) : undefined);
				}
				if (!retainWorkspaceLegacy) {
					await context.workspaceState.update(LEGACY_CONVERSATION_KEY, undefined);
					await context.workspaceState.update(MIGRATION_FLAG_KEY, true);
				}
			} catch (error) {
				// Finalization is not part of the retryable write queue. Preserve its
				// failure until restart, while queue failures clear when their retry succeeds.
				this.writeFailure = error instanceof Error ? error : new Error(String(error));
				throw error;
			}
		});
		const refreshAfterMigration = (): void => {
			if (!this.disposed) {
				try { this._onDidChange.fire(); } catch { /* Notification failures must not change migration's result. */ }
			}
		};
		void this.ready.then(refreshAfterMigration, refreshAfterMigration);
	}

	private reportRecoveryIssue(issue: ConversationRecoveryIssue): void {
		if (!this.encounteredRecoveryIssues.has(issue.path)) {
			this.encounteredRecoveryIssues.set(issue.path, issue);
			this._onDidEncounterRecoveryIssue.fire(issue);
		}
	}

	/** Await pending writes and deletion cleanup, including after UI disposal. */
	async flush(): Promise<void> {
		// Retry prior auxiliary failures once per explicit drain, never in the same failed attempt.
		for (const id of this.failedDeletionCleanups) { this.scheduleDeletionCleanup(id); }
		let tail: Promise<void>;
		do { tail = this.pendingWrite; await tail; } while (tail !== this.pendingWrite);
		const failure = this.writeFailure ?? this.failedWrites.values().next().value;
		if (failure) { throw failure; }
	}

	/** Register host cleanup that survives UI disposal and runs only after durable deletion. */
	setPermanentDeleteCleanup(cleanup: (id: string) => Promise<void>): void {
		this.permanentDeleteCleanup = cleanup;
		for (const id of this.observedDeletions) { this.scheduleDeletionCleanup(id); }
		this.scanDeletions();
	}

	private scanDeletions(): void {
		if (!this.disk || this.disposed) { return; }
		this.scanRequested = true;
		if (this.scanQueued) { return; }
		this.scanQueued = true;
		// Observation must not wait behind a slow save: cancelling active turns
		// precedes their final writes and the independently queued host cleanup.
		const scan = (async () => {
			try {
				do {
					this.scanRequested = false;
					for (const id of await this.disk!.listDeletedIds()) { this.observeDeletion(id); }
				} while (this.scanRequested && !this.disposed);
			} finally { this.scanQueued = false; }
			this._onDidChange.fire();
		})();
		void scan.catch(() => {}); // The write queue reports failures, even if an older save is still pending.
		this.enqueue('lifecycle-scan', () => scan);
	}

	/** Observe once per window before cleanup so active turns lose ownership immediately. */
	private observeDeletion(id: string): void {
		this.pendingRecords.delete(id); this.failedWrites.delete(id);
		if (!this.observedDeletions.has(id)) {
			this.observedDeletions.add(id);
			this._onDidDelete.fire(id); this._onDidChange.fire();
		}
		this.scheduleDeletionCleanup(id);
	}

	private notifyPermanentDeletion(id: string): void {
		if (!this.deletionNotifications.has(id)) {
			this.deletionNotifications.add(id); this._onDidPermanentlyDelete.fire(id); this._onDidChange.fire();
		}
	}

	private scheduleDeletionCleanup(id: string): void {
		const cleanup = this.permanentDeleteCleanup;
		if (!cleanup) { this.notifyPermanentDeletion(id); return; }
		if (this.cleanupScheduled.has(id)) { return; }
		this.cleanupScheduled.add(id);
		this.enqueue(id, async () => {
			try { await cleanup(id); this.failedDeletionCleanups.delete(id); this.notifyPermanentDeletion(id); }
			catch (error) { this.cleanupScheduled.delete(id); this.failedDeletionCleanups.add(id); throw error; }
		});
	}

	private isHidden(id: string): boolean {
		if (this.observedDeletions.has(id)) { return true; }
		if (this.disk?.isPermanentlyDeleted(id)) { this.observeDeletion(id); return true; }
		return this.disk?.isHidden(id) ?? false;
	}

	/** Damaged lifecycle metadata isolates one record without discarding its pending recovery copy. */
	private isVisibleInList(id: string): boolean {
		try { return !this.isHidden(id); }
		catch { return false; } // Storage already reports the preserved marker through the recovery channel.
	}

	private persist(record: ConversationRecord, provisional = true): Promise<void> {
		const snapshot = attachConversationWriteToken(structuredClone(record), record.writeToken ?? { revision: null });
		const previous = this.pendingRecords.get(record.summary.id);
		if (provisional) { this.pendingRecords.set(record.summary.id, snapshot); }
		return this.enqueue(snapshot.summary.id, async () => {
			if (this.disk) {
				try { await this.disk.save(snapshot); }
				catch (error) { if (error instanceof ConversationDeletedError || this.disk.isPermanentlyDeleted(snapshot.summary.id)) { this.observeDeletion(snapshot.summary.id); if (!provisional) { throw new ConversationDeletedError(); } return; } throw error; }
				finally {
					// A fork depends on this snapshot settling, including its known base
					// after a failed write. A conflict never advances that stale base.
					for (const fork of this.pendingTokenForks.get(snapshot) ?? []) { fork.revision = snapshot.writeToken.revision; }
					this.pendingTokenForks.delete(snapshot);
				}
			}
			else {
				await this.context.globalState.update(recordKey(snapshot.summary.id), snapshot.messages);
				const index = this.mementoIndex().filter(summary => summary.id !== snapshot.summary.id);
				await this.context.globalState.update(INDEX_KEY, [...index, snapshot.summary]);
			}
			if (!provisional && this.isHidden(snapshot.summary.id)) { throw new ConversationDeletedError(); }
			if (this.pendingRecords.get(snapshot.summary.id) === (provisional ? snapshot : previous)) { this.pendingRecords.delete(snapshot.summary.id); }
		}, provisional);
	}

	private enqueue(id: string, operation: () => Promise<void>, trackFailure = true): Promise<void> {
		const completion = this.pendingWrite.then(async () => {
			await operation(); this.failedWrites.delete(id);
		});
		// Observe rejection even for legacy fire-and-forget callers. Awaited
		// operations receive their own outcome without unrelated queue failures.
		this.pendingWrite = completion.catch(error => {
			if (!trackFailure) { return; }
			const failure = error instanceof Error ? error : new Error(String(error)); this.failedWrites.set(id, failure);
			if (!this.disposed) {
				try { void Promise.resolve(vscode.window.showErrorMessage(vscode.l10n.t('Conversation history could not be saved: {0}', failure.message))).catch(() => {}); }
				catch { /* Preserve the write failure even if the closing host cannot report it. */ }
			}
		});
		return completion;
	}

	/** Read a title and other metadata without loading the transcript or applying history filters. */
	getSummary(id: string): ConversationSummary | undefined {
		return this.readIndex().find(summary => summary.id === id && !this.isHidden(id));
	}

	/** Returns the conversation summaries, newest-first by `updatedAt`. */
	list(): ReadonlyArray<ConversationSummary> {
		return this.search({ limit: Number.MAX_SAFE_INTEGER }).items;
	}

	/** Conversations created in this workspace; older history remains in list(). */
	listForWorkspace(): ReadonlyArray<ConversationSummary> {
		return this.list().filter(summary => this.isInCurrentWorkspace(summary));
	}

	isInCurrentWorkspace(summary: ConversationSummary): boolean { return summary.workspaceId === this.workspaceId; }

	/** Resume a conversation explicitly selected here; otherwise restore only this workspace’s history. */
	getInitialConversation(): ConversationRecord | undefined {
		const active = this.context.workspaceState.get<string>(ACTIVE_KEY);
		for (const id of new Set([...(active ? [active] : []), ...this.listForWorkspace().map(summary => summary.id)])) {
			try { const record = this.load(id); if (record && !record.summary.archived) { return record; } }
			catch { /* A damaged active transcript must not prevent opening a healthy conversation. */ }
		}
		return undefined;
	}

	/** Remember explicit history selections in this workspace without reassigning their original ownership. */
	rememberActive(id: string): void {
		if (this.load(id) && this.context.workspaceState.get<string>(ACTIVE_KEY) !== id) {
			void this.context.workspaceState.update(ACTIVE_KEY, id);
			this._onDidChangeActive.fire(id);
		}
	}

	/** Returns the full record for a conversation, or `undefined` if missing. */
	load(id: string, includeDeleted = false): ConversationRecord | undefined {
		if (this.isHidden(id)) { return undefined; }
		if (this.pendingRecords.has(id)) {
			const pending = this.pendingRecords.get(id);
			if (!pending || (!includeDeleted && pending.summary.deletedAt)) { return undefined; }
			const token = { revision: pending.writeToken?.revision ?? null };
			const forks = this.pendingTokenForks.get(pending) ?? new Set<ConversationWriteToken>();
			forks.add(token); this.pendingTokenForks.set(pending, forks);
			return attachConversationWriteToken(structuredClone(pending), token);
		}
		if (this.disk) {
			const record = this.disk.load(id);
			return record && (includeDeleted || !record.summary.deletedAt) ? record : undefined;
		}
		const summary = this.readIndex().find(s => s.id === id);
		if (!summary || (summary.deletedAt && !includeDeleted)) { return undefined; }
		return { summary, messages: this.context.globalState.get<ChatMessage[]>(recordKey(id)) ?? [] };
	}

	/**
	 * Create a new conversation with a generated id and a placeholder title.
	 * The title gets replaced on the first `update()` once a user message
	 * arrives. Returns the freshly-created record so the caller can use it
	 * without an extra `load()` round-trip.
	 */
	create(initialMessages?: ChatMessage[]): ConversationRecord {
		const id = generateId();
		const now = Date.now();
		const messages = [...(initialMessages ?? [])];
		const derived = deriveTitle(messages);
		const summary: ConversationSummary = {
			id,
			title: derived ?? 'New conversation',
			createdAt: now,
			updatedAt: now,
			messageCount: messages.length,
			workspaceId: this.workspaceId,
			workspaceName: this.workspaceName,
		};
		const record = attachConversationWriteToken({ summary, messages }, { revision: null });
		this.persist(record);
		this._onDidChange.fire();
		return record;
	}

	/**
	 * Persist the latest message list for the given conversation. Refreshes
	 * `updatedAt`, recomputes `messageCount`, optionally records the
	 * `lastSpecialist`, the `lastMode`, and the `lastTab`, and (when the
	 * title is still the placeholder) derives a real title from the first
	 * user message.
	 */
	update(
		id: string,
		messages: ChatMessage[],
		lastSpecialist?: AgentHandle | 'anton',
		lastMode?: ChatMode,
		lastTab?: ChatTab,
		lastModel?: ModelId,
		writeToken?: ConversationWriteToken,
	): void {
		void this.writeUpdate(id, messages, lastSpecialist, lastMode, lastTab, lastModel, writeToken, true);
	}

	/** Commit this exact update before returning, without exposing a provisional rewind in History. */
	async updateAndWait(
		id: string, messages: ChatMessage[], lastSpecialist?: AgentHandle | 'anton',
		lastMode?: ChatMode, lastTab?: ChatTab, lastModel?: ModelId, writeToken?: ConversationWriteToken,
	): Promise<void> {
		await this.writeUpdate(id, messages, lastSpecialist, lastMode, lastTab, lastModel, writeToken, false);
		try { this._onDidChange.fire(); } catch { /* The transcript is already durable. */ }
	}

	private writeUpdate(
		id: string, messages: ChatMessage[], lastSpecialist: AgentHandle | 'anton' | undefined,
		lastMode: ChatMode | undefined, lastTab: ChatTab | undefined, lastModel: ModelId | undefined,
		writeToken: ConversationWriteToken | undefined, provisional: boolean,
	): Promise<void> | undefined {
		const index = this.readIndex();
		const existing = index.find(s => s.id === id);
		if (!existing || (!provisional && existing.deletedAt !== undefined)) {
			if (!provisional) { throw new Error(vscode.l10n.t('The conversation is no longer available to rewind.')); }
			return;
		}
		const trimmed = [...messages];
		const next: ConversationSummary = {
			...existing,
			id: existing.id,
			title: this.shouldRederiveTitle(existing.title)
				? deriveTitle(trimmed) ?? existing.title
				: existing.title,
			createdAt: existing.createdAt,
			updatedAt: Date.now(),
			messageCount: trimmed.length,
			lastSpecialist: lastSpecialist ?? existing.lastSpecialist,
			lastMode: lastMode ?? existing.lastMode,
			lastTab: lastTab ?? existing.lastTab,
			lastModel: lastModel ?? existing.lastModel,
			workspaceId: existing.workspaceId,
			workspaceName: existing.workspaceName,
		};
		const token = writeToken ?? this.load(id, true)?.writeToken ?? { revision: null };
		const completion = this.persist(attachConversationWriteToken({ summary: next, messages: trimmed }, token), provisional);
		if (provisional) { this._onDidChange.fire(); }
		return completion;
	}

	/**
	 * Rename a conversation. Trims surrounding whitespace and caps the title
	 * length so a malformed input box payload can't poison the index.
	 */
	rename(id: string, newTitle: string): void {
		const record = this.load(id, true); if (!record) { return; }
		const cleaned = newTitle.trim().slice(0, MAX_TITLE_LENGTH); if (!cleaned) { return; }
		const next: ConversationSummary = { ...record.summary, title: cleaned, updatedAt: Date.now() };
		this.persist(attachConversationWriteToken({ summary: next, messages: record.messages }, record.writeToken ?? { revision: null }));
		this._onDidChange.fire();
	}

	/** Move to Trash; body and checkpoint association remain recoverable. */
	delete(id: string): void {
		const record = this.load(id); if (!record) { return; }
		this.persist(attachConversationWriteToken({ ...record, summary: { ...record.summary, deletedAt: Date.now() } }, record.writeToken ?? { revision: null }));
		this._onDidDelete.fire(id); this._onDidChange.fire();
	}

	restore(id: string): void { this.changeSummary(id, { deletedAt: undefined, archived: false }); }
	setPinned(id: string, pinned: boolean): void { this.changeSummary(id, { pinned }); }
	archive(id: string, archived = true): void { this.changeSummary(id, { archived }); }

	private changeSummary(id: string, change: Partial<ConversationSummary>): void {
		const record = this.load(id, true); if (!record) { return; }
		this.persist(attachConversationWriteToken({ ...record, summary: { ...record.summary, ...change } }, record.writeToken ?? { revision: null })); this._onDidChange.fire();
	}

	/** Permanently remove only an already trashed record, after host confirmation. */
	permanentDelete(id: string): void {
		const record = this.load(id, true); if (!record?.summary.deletedAt) { return; }
		this.pendingRecords.set(id, null);
		this.enqueue(id, async () => {
			try {
				if (this.disk) { await this.disk.delete(id); }
				else { await this.deleteFromMemento(record); }
			} catch (error) {
				if (this.disk?.isPermanentlyDeleted(id)) { this.observeDeletion(id); return; }
				// Remove only this pending tombstone. Keep the complete Trash record
				// available for recovery/retry even if the backing deletion was partial.
				if (this.pendingRecords.get(id) === null) { this.pendingRecords.set(id, record); }
				this._onDidChange.fire(); throw error;
			}
			// Cleanup stays in the draining write queue even after UI disposal.
			this.observeDeletion(id);
		});
		this._onDidChange.fire();
	}

	private async deleteFromMemento(record: ConversationRecord): Promise<void> {
		const id = record.summary.id; let bodyAttempted = false;
		try {
			await this.context.globalState.update(INDEX_KEY, this.mementoIndex().filter(summary => summary.id !== id));
			bodyAttempted = true; await this.context.globalState.update(recordKey(id), undefined);
		} catch (error) {
			// Memento has no multi-key transaction. Restore the index if removing the
			// body fails, including hosts that update their cache before rejecting.
			try {
				if (bodyAttempted) { await this.context.globalState.update(recordKey(id), record.messages); }
				const index = this.mementoIndex().filter(summary => summary.id !== id);
				await this.context.globalState.update(INDEX_KEY, [...index, record.summary]);
			} catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Conversation deletion failed and its stored Trash record could not be restored. The transcript remains available in this window.'); }
			throw error;
		}
	}

	/** Fork through an inclusive message boundary. Selecting the fork never modifies files. */
	branch(id: string, throughMessageIndex: number, options: { checkpointId?: string; workspaceState: 'checkpoint-available' | 'unlinked' } = { workspaceState: 'unlinked' }): ConversationRecord | undefined {
		const source = this.load(id); if (!source || !Number.isInteger(throughMessageIndex) || throughMessageIndex < 0 || throughMessageIndex >= source.messages.length) { return undefined; }
		const now = Date.now(); const branchId = generateId();
		const messages = structuredClone(source.messages.slice(0, throughMessageIndex + 1));
		const record: ConversationRecord = { messages, summary: { ...source.summary, id: branchId, title: vscode.l10n.t('Branch: {0}', source.summary.title).slice(0, MAX_TITLE_LENGTH), createdAt: now, updatedAt: now, messageCount: messages.length, pinned: false, archived: false, deletedAt: undefined, workspaceId: this.workspaceId, workspaceName: this.workspaceName, branch: { parentId: id, throughMessageIndex, checkpointId: options.checkpointId, workspaceState: options.checkpointId ? options.workspaceState : 'unlinked' } } };
		attachConversationWriteToken(record, { revision: null }); this.persist(record); this._onDidChange.fire(); return record;
	}

	/** Synchronous metadata-only listing. Body queries must use searchAsync to avoid blocking the host. */
	search(options: ConversationSearchOptions = {}): ConversationSearchResult {
		const query = this.normaliseQuery(options.query);
		return this.searchPage(this.readIndex().filter(summary => this.inSearchScope(summary, options) && this.matchesMetadata(summary, query)), options);
	}

	/** Exact body search reads text-only indexes in cancellable bounded chunks; it never loads transcripts. */
	async searchAsync(options: ConversationSearchOptions = {}, cancellation?: AbortSignal): Promise<ConversationSearchResult> {
		const signal = cancellation ? AbortSignal.any([cancellation, this.searchLifetime.signal]) : this.searchLifetime.signal;
		signal.throwIfAborted(); const query = this.normaliseQuery(options.query);
		const summaries = this.disk ? await this.disk.listAsync(signal) : this.readIndex();
		const index = new Map(summaries.map(summary => [summary.id, summary]));
		for (const [id, record] of this.pendingRecords) { if (record && this.isVisibleInList(id)) { index.set(id, record.summary); } else { index.delete(id); } }
		const matches: ConversationSummary[] = [];
		for (const summary of index.values()) {
			signal.throwIfAborted();
			if (!this.inSearchScope(summary, options)) { continue; }
			if (this.matchesMetadata(summary, query)) { matches.push(summary); continue; }
			try {
				const pending = this.pendingRecords.get(summary.id);
				if (this.disk && !pending) {
					if (await this.disk.matches(summary.id, query, signal)) { matches.push(summary); }
				} else {
					const messages = pending?.messages ?? this.context.globalState.get<ChatMessage[]>(recordKey(summary.id)) ?? [];
					for (const text of conversationTextChunks(messages)) {
						signal.throwIfAborted();
						if (text.includes(query)) { matches.push(summary); break; }
						await new Promise<void>(resolve => setImmediate(resolve));
					}
				}
			} catch { signal.throwIfAborted(); /* Damaged histories retain their visible metadata and recovery notice. */ }
		}
		signal.throwIfAborted(); return this.searchPage(matches.filter(summary => this.isVisibleInList(summary.id)), options);
	}

	private normaliseQuery(query?: string): string {
		if ((query?.length ?? 0) > MAX_HISTORY_QUERY_LENGTH) { throw new Error(vscode.l10n.t('Search text is too long. Use {0} characters or fewer.', MAX_HISTORY_QUERY_LENGTH)); }
		return query?.trim().toLowerCase() ?? '';
	}

	private inSearchScope(summary: ConversationSummary, options: ConversationSearchOptions): boolean {
		if (options.workspaceOnly && summary.workspaceId !== this.workspaceId) { return false; }
		const scope = options.scope ?? 'active';
		return !(scope === 'trash' ? !summary.deletedAt : scope === 'archived' ? summary.deletedAt || !summary.archived : scope === 'active' ? summary.deletedAt || summary.archived : false);
	}

	private matchesMetadata(summary: ConversationSummary, query: string): boolean {
		return !query || [summary.title, summary.workspaceName, summary.lastSpecialist].some(value => value?.toLowerCase().includes(query));
	}

	private searchPage(matches: ConversationSummary[], options: ConversationSearchOptions): ConversationSearchResult {
		matches.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
		const offset = Math.max(0, Math.floor(options.offset ?? 0)); const limit = Math.max(1, Math.floor(options.limit ?? 50));
		return { items: matches.slice(offset, offset + limit), total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : undefined };
	}

	/** Remove an unavailable checkpoint link without suggesting the files match the branch. */
	unlinkBranchCheckpoint(id: string): void {
		const record = this.load(id); if (record?.summary.branch) { this.changeSummary(id, { branch: { ...record.summary.branch, checkpointId: undefined, workspaceState: 'unlinked' } }); }
	}

	/** Read one saved response from its page, excluding Trash and pending or committed deletion. */
	loadMessage(id: string, index: number): ChatMessage | undefined {
		if (!Number.isSafeInteger(index) || index < 0 || this.isHidden(id)) { return undefined; }
		if (this.pendingRecords.has(id)) {
			const pending = this.pendingRecords.get(id);
			return pending && !pending.summary.deletedAt ? pending.messages[index] : undefined;
		}
		if (this.disk) {
			const record = this.disk.load(id, index, 1);
			return record && !record.summary.deletedAt ? record.messages[0] : undefined;
		}
		return this.load(id)?.messages[index];
	}

	/** Read a bounded message page without loading the complete stored transcript. */
	loadMessages(id: string, offset: number, limit = 100): ChatMessage[] {
		if (this.isHidden(id)) { return []; }
		const pending = this.pendingRecords.get(id);
		if (this.pendingRecords.has(id)) { return pending?.messages.slice(offset, offset + limit) ?? []; }
		if (this.disk) { return this.disk.load(id, offset, limit)?.messages ?? []; }
		return (pending ?? this.load(id))?.messages.slice(offset, offset + limit) ?? [];
	}

	dispose(): void {
		this.disposed = true; this.lifecycleWatcher?.dispose(); this.searchLifetime.abort();
		this._onDidChange.dispose(); this._onDidDelete.dispose(); this._onDidChangeActive.dispose(); this._onDidPermanentlyDelete.dispose(); this._onDidEncounterRecoveryIssue.dispose();
	}

	private readIndex(): ConversationSummary[] {
		const summaries = this.disk ? this.disk.list() : this.mementoIndex();
		const index = new Map(summaries.map(summary => [summary.id, summary]));
		for (const [id, record] of this.pendingRecords) { if (record && this.isVisibleInList(id)) { index.set(id, record.summary); } else { index.delete(id); } }
		return [...index.values()];
	}

	private mementoIndex(): ConversationSummary[] {
		const raw = this.context.globalState.get<ConversationSummary[]>(INDEX_KEY); return Array.isArray(raw) ? raw : [];
	}

	/**
	 * Determine whether the title is still a placeholder we should overwrite
	 * on the next `update()`. We only re-derive when the user hasn't already
	 * picked a custom name via `rename()`.
	 */
	private shouldRederiveTitle(currentTitle: string): boolean {
		return currentTitle === 'New conversation' || currentTitle === 'Imported conversation';
	}
}
