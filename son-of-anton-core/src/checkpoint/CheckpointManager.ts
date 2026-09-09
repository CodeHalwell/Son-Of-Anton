/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileSnapshotStore, type FileSnapshot } from './FileSnapshotStore';
import { randomUUID, createHash } from 'node:crypto';
import { GitSnapshotStore, type GitSnapshot } from './GitSnapshotStore';
import { TypedEventEmitter, type Event } from '../eventEmitter';
import type { ConfigStore, Disposable, MementoStore, Notifier } from '../host';

/**
 * Minimal conversation-store contract the checkpoint manager depends on for
 * the `restore conversation too` flow. The extension's full `ConversationStore`
 * satisfies this shape; tests / future CLI implementations only need to
 * implement these two methods.
 */
export interface ConversationStoreLike {
	load(conversationId: string): { readonly messages: ReadonlyArray<unknown>; readonly summary: { readonly lastSpecialist?: string } } | undefined;
	update(conversationId: string, messages: ReadonlyArray<unknown>, lastSpecialist?: string): void;
}

/**
 * Storage key for the checkpoint index. We keep all checkpoints in a single
 * `globalState` array so listing for the History UI is a single read; the
 * payload is small (no file content for git checkpoints, just SHAs and
 * metadata) so a flat index scales fine to {@link DEFAULT_MAX_CHECKPOINTS}.
 */
const CHECKPOINT_INDEX_KEY = 'sota.checkpoints.index';

/**
 * Default upper bound on the total checkpoint count across all conversations.
 * Past this we prune the oldest. Configurable via `sota.checkpoints.maxCount`.
 */
const DEFAULT_MAX_CHECKPOINTS = 100;

/**
 * Hard ceiling on the configured max — protects against a user pasting a
 * pathological value into settings. 1000 checkpoints is already excessive
 * given we reference one git commit per entry.
 */
const HARD_MAX_CHECKPOINTS = 1000;

/**
 * A persisted snapshot of the workspace state captured at a single chat turn.
 * Kept deliberately small — for git-backed checkpoints we store only a SHA
 * and rely on the repository's object database to retain the actual content.
 */
export interface Checkpoint {
	/** Random identifier minted at capture time. Stable across sessions. */
	readonly id: string;
	/** Conversation that owns this checkpoint. */
	readonly conversationId: string;
	/** The original conversation was permanently deleted; only explicit branches retain this checkpoint. */
	readonly ownerDeleted?: boolean;
	readonly branchConversationIds?: readonly string[];
	/** 0-based ordinal of the turn within the conversation. */
	readonly turnIndex: number;
	/** Milliseconds since epoch. Used for the relative-time tooltip. */
	readonly capturedAt: number;
	/**
	 * Truncated copy of the user message that triggered this turn. Surfaced in
	 * the quick-pick so the user can pick the right checkpoint without
	 * reopening every conversation.
	 */
	readonly userMessage: string;
	/** Strategy used to capture the checkpoint. */
	readonly kind: 'git' | 'fs';
	/** Retained working-tree commit, only for `kind: 'git'`. */
	readonly gitSha?: string;
	/** Versioned snapshot with worktree identity and staging state. */
	readonly snapshot?: GitSnapshot;
	readonly fileSnapshot?: FileSnapshot;
	/** Reference the SHA was based on at capture time (HEAD or branch). */
	readonly baseRef?: string;
	/** Human-readable summary (e.g. "3 files modified"). Optional, best-effort. */
	readonly summary?: string;
}

/**
 * Options for {@link CheckpointManager.restore}. `conversationToo` rewinds the
 * persisted conversation alongside the workspace so the user can re-issue
 * the failed turn cleanly without ghost messages from the aborted exchange.
 */
export interface RestoreOptions {
	conversationToo: boolean;
	conversationId?: string;
}

/**
 * Host-supplied collaborators the checkpoint manager needs in order to
 * surface modal prompts and a workspace root without depending on `vscode`.
 */
export interface CheckpointManagerHost {
	readonly storageRoot?: string;
	readonly notifier: Notifier;
	readonly config: ConfigStore;
	readonly getWorkspaceRoot: () => string | undefined;
	/**
	 * Surface a destructive-action confirmation. Returns true when the user
	 * approves the restore. Defaults to false (cancel) if undefined.
	 */
	readonly confirmRestore: (message: string) => Promise<boolean>;
}

export class CheckpointManager implements Disposable {
	private readonly _onDidChange = new TypedEventEmitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private pendingWrite: Promise<void> = Promise.resolve();

	constructor(
		private readonly conversationStore: ConversationStoreLike,
		private readonly globalState: MementoStore,
		private readonly host: CheckpointManagerHost,
	) { }

	/**
	 * Capture a checkpoint of the current workspace state. Returns
	 * `undefined` if the user has disabled checkpoints, no workspace folder is
	 * open, or capture failed. Non-Git folders use complete bounded file snapshots.
	 */
	async capture(conversationId: string, turnIndex: number, userMessage: string): Promise<Checkpoint | undefined> {
		if (!this.isEnabled()) {
			return undefined;
		}
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			return undefined;
		}

		const checkpoint = await this.captureGit(workspaceRoot, conversationId, turnIndex, userMessage);
		if (!checkpoint) {
			return undefined;
		}

		await this.mutateIndex(index => this.pruneIndex([...index, checkpoint]), checkpoint.snapshot?.workspaceRoot ?? checkpoint.fileSnapshot?.workspaceRoot);
		this._onDidChange.fire();
		return checkpoint;
	}

	/** Return the checkpoints belonging to a single conversation, oldest first. */
	list(conversationId: string): ReadonlyArray<Checkpoint> {
		return this.readIndex()
			.filter(cp => (!cp.ownerDeleted && cp.conversationId === conversationId) || cp.branchConversationIds?.includes(conversationId))
			.sort((a, b) => a.capturedAt - b.capturedAt);
	}

	/** Return every checkpoint across all conversations, oldest first. */
	listAll(): ReadonlyArray<Checkpoint> {
		return [...this.readIndex()].sort((a, b) => a.capturedAt - b.capturedAt);
	}

	get(id: string): Checkpoint | undefined {
		return this.readIndex().find(cp => cp.id === id);
	}

	/**
	 * Restore the workspace (and optionally the conversation) to the state
	 * captured by this checkpoint. Prompts the user for confirmation via a
	 * modal warning before touching the working tree — restore is destructive
	 * by definition. Caller is responsible for aborting any in-flight LLM
	 * stream before invoking this method.
	 */
	async restore(id: string, options: RestoreOptions): Promise<void> {
		const checkpoint = this.get(id);
		if (!checkpoint) {
			this.host.notifier.error('Checkpoint not found.');
			return;
		}

		options = { ...options, conversationId: options.conversationId ?? (checkpoint.ownerDeleted ? checkpoint.branchConversationIds?.[0] : checkpoint.conversationId) };
		if (!options.conversationId || !((!checkpoint.ownerDeleted && options.conversationId === checkpoint.conversationId) || checkpoint.branchConversationIds?.includes(options.conversationId))) { throw new Error('Checkpoint is not associated with this conversation.'); }
		const root = this.getWorkspaceRoot();
		if (root && checkpoint.kind === 'fs' && checkpoint.fileSnapshot) {
			await this.restoreFiles(checkpoint, root, options); return;
		}
		if (!root || !checkpoint.snapshot) {
			throw new Error('This legacy checkpoint has no verified worktree snapshot. Capture a new checkpoint before making changes.');
		}
		const store = new GitSnapshotStore(root);
		const recovery = await store.restore(checkpoint.snapshot, async files => {
			const preview = files.slice(0, 20).map(file => `  ${file}`).join('\n');
			const confirmed = await this.host.confirmRestore(
				`Restore ${files.length} changed paths to this checkpoint? Tracked and non-ignored untracked files are restored; the staging area is preserved as captured. A recovery checkpoint will be retained.\n${preview}${files.length > 20 ? '\n  …' : ''}${options.conversationToo ? '\nThe conversation will also be rewound.' : ''}`,
			);
			if (this.getWorkspaceRoot() !== root) { throw new Error('Workspace changed while confirming restore.'); }
			return confirmed;
		});
		if (!recovery) {
			return;
		}
		await this.mutateIndex(index => this.pruneIndex([...index, {
			id: randomUUID(), conversationId: options.conversationId ?? checkpoint.conversationId,
			turnIndex: this.conversationStore.load(options.conversationId ?? checkpoint.conversationId)?.messages.length ?? checkpoint.turnIndex,
			capturedAt: Date.now(), userMessage: 'Recovery point before checkpoint restore',
			kind: 'git', gitSha: recovery.commit, baseRef: recovery.head,
			snapshot: recovery, summary: 'Recovery point before restore',
		}]), recovery.workspaceRoot);
		this._onDidChange.fire();
		this.host.notifier.info('Workspace restored. The previous state is available as a recovery checkpoint.');

		if (options.conversationToo) {
			this.rewindConversation(checkpoint, options.conversationId);
		}
	}

	/**
	 * Drop every checkpoint belonging to this conversation. Called when a
	 * conversation is deleted so we don't keep dangling index entries.
	 */
	async deleteFor(conversationId: string): Promise<void> {
		await this.mutateIndex(index => index.map(cp => ({
			...cp,
			ownerDeleted: cp.ownerDeleted || cp.conversationId === conversationId,
			branchConversationIds: cp.branchConversationIds?.filter(id => id !== conversationId),
		})).filter(cp => !cp.ownerDeleted || !!cp.branchConversationIds?.length));
		this._onDidChange.fire();
	}

	/** Explicit links keep a branch's checkpoint alive even if its parent is deleted. */
	async attachToBranch(checkpointId: string, branchId: string): Promise<void> {
		if (!this.conversationStore.load(branchId) || !this.get(checkpointId)) { throw new Error('Branch or checkpoint is unavailable.'); }
		await this.mutateIndex(index => index.map(cp => cp.id === checkpointId ? { ...cp, branchConversationIds: [...new Set([...(cp.branchConversationIds ?? []), branchId])] } : cp));
		this._onDidChange.fire();
	}

	size(): number {
		return this.readIndex().length;
	}

	dispose(): void {
		this._onDidChange.dispose();
	}

	// ------------------------------------------------------------------
	// Internals
	// ------------------------------------------------------------------

	private isEnabled(): boolean {
		return this.host.config.get<boolean>('checkpoints.enabled', true);
	}

	private getMaxCount(): number {
		const raw = this.host.config.get<number>('checkpoints.maxCount', DEFAULT_MAX_CHECKPOINTS);
		if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
			return DEFAULT_MAX_CHECKPOINTS;
		}
		return Math.min(Math.floor(raw), HARD_MAX_CHECKPOINTS);
	}

	/**
	 * Resolve the workspace root via the host. Multi-root workspaces use the
	 * first folder (the host abstraction is responsible for picking).
	 */
	private getWorkspaceRoot(): string | undefined {
		return this.host.getWorkspaceRoot();
	}

	/**
	 * Determine whether the workspace root is the working tree of a git
	 * repository. We look for a top-level `.git` entry (file or directory —
	 * `.git` is a regular file when the folder is a worktree). This is
	 * cheap and avoids spawning a subprocess for the common "no git here"
	 * case. Workspace snapshots require the worktree root so their scope
	 * matches the folder displayed to the user.
	 */
	private isGitRepo(workspaceRoot: string): boolean {
		try {
			return fs.existsSync(path.join(workspaceRoot, '.git'));
		} catch {
			return false;
		}
	}

	private async captureGit(
		workspaceRoot: string,
		conversationId: string,
		turnIndex: number,
		userMessage: string,
	): Promise<Checkpoint | undefined> {
		if (!this.isGitRepo(workspaceRoot)) {
			try {
				const fileSnapshot = await new FileSnapshotStore(workspaceRoot, this.fileStorageRoot()).capture();
				return { id: randomUUID(), conversationId, turnIndex, capturedAt: Date.now(), userMessage: userMessage.slice(0, 200), kind: 'fs', fileSnapshot, summary: 'Files up to 50 MiB / 10,000 entries; VCS internals, node_modules, .venv and __pycache__ excluded; symlinks unsupported' };
			} catch (error) {
				this.host.notifier.warn(`Checkpoint was not captured: ${error instanceof Error ? error.message : String(error)}`); return undefined;
			}
		}

		try {
			const snapshot = await new GitSnapshotStore(workspaceRoot).capture();
			return {
				id: randomUUID(), conversationId, turnIndex, capturedAt: Date.now(),
				userMessage: userMessage.slice(0, 200), kind: 'git',
				gitSha: snapshot.commit, baseRef: snapshot.head, snapshot,
				summary: 'Tracked and non-ignored untracked files, including staging state',
			};
		} catch (error) {
			this.host.notifier.warn(`Checkpoint was not captured: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	private fileStorageRoot(): string { return this.host.storageRoot ?? path.join(os.homedir(), '.son-of-anton', 'file-checkpoints'); }

	private async restoreFiles(checkpoint: Checkpoint, root: string, options: RestoreOptions): Promise<void> {
		const recovery = await new FileSnapshotStore(root, this.fileStorageRoot()).restore(checkpoint.fileSnapshot!, async files => {
			const preview = files.slice(0, 20).map(file => `  ${file}`).join('\n');
			const confirmed = await this.host.confirmRestore(`Restore ${files.length} changed paths? A recovery checkpoint will retain the current files. Dependencies and VCS internals are excluded.\n${preview}${files.length > 20 ? '\n  …' : ''}${options.conversationToo ? '\nThe conversation will also be rewound.' : ''}`);
			if (this.getWorkspaceRoot() !== root) { throw new Error('Workspace changed while confirming restore.'); }
			return confirmed;
		});
		if (!recovery) { return; }
		await this.mutateIndex(index => this.pruneIndex([...index, {
			id: randomUUID(), conversationId: options.conversationId ?? checkpoint.conversationId, turnIndex: this.conversationStore.load(options.conversationId ?? checkpoint.conversationId)?.messages.length ?? checkpoint.turnIndex,
			capturedAt: Date.now(), userMessage: 'Recovery point before checkpoint restore', kind: 'fs', fileSnapshot: recovery, summary: 'Recovery point before restore',
		}]), root);
		this._onDidChange.fire(); this.host.notifier.info('Workspace restored. The previous state is available as a recovery checkpoint.');
		if (options.conversationToo) { this.rewindConversation(checkpoint, options.conversationId); }
	}

	/**
	 * Truncate the conversation back to the state immediately before the
	 * captured turn. The checkpoint records `turnIndex` as the message count
	 * at capture time, so slicing to `turnIndex` drops the user message that
	 * triggered the turn AND every assistant/tool message that followed.
	 */
	private rewindConversation(checkpoint: Checkpoint, conversationId = checkpoint.conversationId): void {
		if (conversationId !== checkpoint.conversationId && !checkpoint.branchConversationIds?.includes(conversationId)) { throw new Error('Checkpoint is not associated with this conversation.'); }
		const record = this.conversationStore.load(conversationId);
		if (!record) {
			return;
		}
		const trimmed = record.messages.slice(0, checkpoint.turnIndex);
		this.conversationStore.update(
			conversationId,
			trimmed,
			record.summary.lastSpecialist,
		);
	}

	private storageKey(root = this.getWorkspaceRoot()): string {
		if (!root) {
			return `${CHECKPOINT_INDEX_KEY}.no-workspace`;
		}
		// Match fs.promises.realpath used by both snapshot stores. The JS fallback
		// preserves input casing on Windows, splitting reads and writes across keys.
		const canonical = fs.realpathSync.native(root);
		return `${CHECKPOINT_INDEX_KEY}.${createHash('sha256').update(canonical).digest('hex')}`;
	}

	private readIndex(): Checkpoint[] {
		const raw = this.globalState.get<Checkpoint[]>(this.storageKey());
		return Array.isArray(raw) ? [...raw] : [];
	}

	private mutateIndex(update: (index: Checkpoint[]) => Checkpoint[], root = this.getWorkspaceRoot()): Promise<void> {
		const key = this.storageKey(root);
		const operation = this.pendingWrite.then(async () => {
			const previous = this.globalState.get<Checkpoint[]>(key) ?? [];
			const next = update([...previous]);
			await this.globalState.update(key, next);
			for (const removed of previous.filter(item => !next.some(retained => retained.id === item.id))) {
				if (removed.fileSnapshot) {
					await new FileSnapshotStore(removed.fileSnapshot.workspaceRoot, removed.fileSnapshot.storageRoot).release(removed.fileSnapshot).catch(error => {
						this.host.notifier.warn(`Could not release an expired file checkpoint: ${String(error)}`);
					});
				}
				if (removed.snapshot) {
					await new GitSnapshotStore(removed.snapshot.workspaceRoot).release(removed.snapshot).catch(error => {
						this.host.notifier.warn(`Could not release an expired checkpoint: ${String(error)}`);
					});
				}
			}
		});
		this.pendingWrite = operation.catch(() => { /* Allow the next persistence attempt after a failure. */ });
		return operation;
	}

	private pruneIndex(index: Checkpoint[]): Checkpoint[] {
		const retained = index.filter(checkpoint => checkpoint.branchConversationIds?.length);
		return [...retained, ...index.filter(checkpoint => !checkpoint.branchConversationIds?.length).sort((a, b) => b.capturedAt - a.capturedAt).slice(0, this.getMaxCount())];
	}

}
