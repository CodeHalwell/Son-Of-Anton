/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CheckpointIndexCommitUncertainError, CheckpointIndexStorage } from './CheckpointIndexStorage';
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
	load(conversationId: string): { readonly messages: ReadonlyArray<unknown>; readonly summary: { readonly lastSpecialist?: string }; readonly writeToken?: { revision: string | null } } | undefined;
	update(conversationId: string, messages: ReadonlyArray<unknown>, lastSpecialist?: string, lastMode?: undefined, lastTab?: undefined, lastModel?: undefined, writeToken?: { revision: string | null }): void;
}

/**
 * Legacy migration source. Shared file-backed indexes are authoritative;
 * per-window Memento snapshots must never replace an existing durable index.
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
	private readonly activeRestores = new Set<ReadonlySet<string>>();
	private readonly indexes = new Map<string, CheckpointIndexStorage>();

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

		let indexed = false;
		try {
			await this.mutateIndex((index, pinned) => this.pruneIndex([...index, checkpoint], pinned), checkpoint.snapshot?.workspaceRoot ?? checkpoint.fileSnapshot?.workspaceRoot, () => { indexed = true; });
		} catch (error) {
			// Only this newly captured payload is disposable before the index
			// commits. A later pruning/notification failure must not remove a
			// snapshot that history or a branch can already reference.
			if (!indexed && !(error instanceof CheckpointIndexCommitUncertainError) && (checkpoint.fileSnapshot || checkpoint.snapshot)) {
				try {
					if (checkpoint.fileSnapshot) { const snapshot = checkpoint.fileSnapshot; await new FileSnapshotStore(snapshot.workspaceRoot, snapshot.storageRoot).release(snapshot); }
					if (checkpoint.snapshot) { await new GitSnapshotStore(checkpoint.snapshot.workspaceRoot).release(checkpoint.snapshot); }
				}
				catch (cleanupError) {
					try { this.host.notifier.warn(`Could not release an unindexed ${checkpoint.fileSnapshot ? 'file' : 'Git'} checkpoint: ${String(cleanupError)}`); }
					catch { /* Preserve the index failure even if the host cannot report cleanup. */ }
				}
			}
			throw error;
		}
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
		await this.restoreWithRecovery(checkpoint, root, options, retainRecovery => store.restore(checkpoint.snapshot!, async files => {
			const preview = files.slice(0, 20).map(file => `  ${file}`).join('\n');
			const confirmed = await this.host.confirmRestore(
				`Restore ${files.length} changed paths to this checkpoint? Tracked and non-ignored untracked files are restored; the staging area is preserved as captured. A recovery checkpoint will be retained.\n${preview}${files.length > 20 ? '\n  …' : ''}${options.conversationToo ? '\nThe conversation will also be rewound.' : ''}`,
			);
			if (this.getWorkspaceRoot() !== root) { throw new Error('Workspace changed while confirming restore.'); }
			return confirmed;
		}, retainRecovery));
	}

	/**
	 * Drop every checkpoint belonging to this conversation. Called when a
	 * conversation is deleted so we don't keep dangling index entries.
	 */
	async deleteFor(conversationId: string): Promise<void> {
		await this.enqueue(async () => {
			await CheckpointIndexStorage.markDeleted(this.fileStorageRoot(), conversationId, message => this.host.notifier.warn(message));
			await this.updateAllIndexes((index, pinned) => {
				if (index.some(cp => pinned.has(cp.id) && (cp.conversationId === conversationId || cp.branchConversationIds?.includes(conversationId)))) { throw new Error('This conversation has a checkpoint restore in progress. Retry deletion after it finishes.'); }
				return index.map(cp => ({ ...cp,
					ownerDeleted: cp.ownerDeleted || cp.conversationId === conversationId,
					branchConversationIds: cp.branchConversationIds?.filter(id => id !== conversationId),
				})).filter(cp => !cp.ownerDeleted || !!cp.branchConversationIds?.length);
			}, conversationId);
		});
		this._onDidChange.fire();
	}

	/** Undo a provisional branch link without permanently deleting the recoverable conversation. */
	async detachBranch(branchId: string): Promise<void> {
		await this.enqueue(() => this.updateAllIndexes((index, pinned) => {
			if (index.some(cp => pinned.has(cp.id) && cp.branchConversationIds?.includes(branchId))) { throw new Error('This branch has a checkpoint restore in progress. Retry after it finishes.'); }
			return index.map(cp => ({ ...cp, branchConversationIds: cp.branchConversationIds?.filter(id => id !== branchId) }));
		}));
		this._onDidChange.fire();
	}

	private async updateAllIndexes(update: (index: Checkpoint[], pinned: ReadonlySet<string>) => Checkpoint[], deletedConversationId?: string): Promise<void> {
		const discovered = await CheckpointIndexStorage.discover(this.fileStorageRoot());
		const roots = new Set([...discovered.roots, ...this.indexes.keys()]); const errors = discovered.errors;
		// The current key is available even to hosts without legacy-key enumeration.
		const current = this.getWorkspaceRoot();
		if (current) { try { roots.add(fs.realpathSync.native(current)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { errors.push(error); } } }
		else { roots.add('no-workspace'); }
		let keys: readonly string[] = [];
		try { keys = this.globalState.keys?.() ?? []; } catch (error) { errors.push(error); }
		const knownKeys = new Set([...roots].map(root => this.keyForIdentity(root)));
		for (const key of keys) {
			if (!key.startsWith(`${CHECKPOINT_INDEX_KEY}.`) || knownKeys.has(key)) { continue; }
			try {
				if (key === `${CHECKPOINT_INDEX_KEY}.no-workspace`) { roots.add('no-workspace'); continue; }
				if (!/^[a-f0-9]{64}$/.test(key.slice(CHECKPOINT_INDEX_KEY.length + 1))) { continue; }
				const entries = this.globalState.get<Checkpoint[]>(key) ?? [];
				if (!Array.isArray(entries)) { throw new Error('Invalid legacy checkpoint index.'); }
				for (const checkpoint of entries) {
					const root = checkpoint?.fileSnapshot?.workspaceRoot ?? checkpoint?.snapshot?.workspaceRoot;
					// Old SHA-only metadata has no releasable payload or reversible workspace identity.
					if (root === undefined) { continue; }
					if (typeof root !== 'string' || !path.isAbsolute(root) || path.normalize(root) !== root || this.keyForIdentity(root) !== key) { throw new Error('Invalid legacy checkpoint workspace identity.'); }
					roots.add(root);
				}
			} catch (error) { errors.push(error); }
			await new Promise<void>(resolve => setImmediate(resolve));
		}

		for (const root of roots) {
			try { const storage = this.indexForIdentity(root); await storage.mutate(update, undefined, deletedConversationId); await this.cleanupIndex(storage); }
			catch (error) { errors.push(error); }
		}
		if (errors.length === 1) { throw errors[0]; }
		if (errors.length) { throw new AggregateError(errors, 'Checkpoint cleanup is incomplete in one or more workspaces. Retry after their stored indexes are available.'); }
	}

	/** Explicit links keep a branch's checkpoint alive even if its parent is deleted. */
	async attachToBranch(checkpointId: string, branchId: string): Promise<void> {
		if (!this.conversationStore.load(branchId) || !this.get(checkpointId)) { throw new Error('Branch or checkpoint is unavailable.'); }
		await this.mutateIndex(index => {
			if (!index.some(cp => cp.id === checkpointId)) { throw new Error('Checkpoint is no longer available.'); }
			return index.map(cp => cp.id === checkpointId ? { ...cp, branchConversationIds: [...new Set([...(cp.branchConversationIds ?? []), branchId])] } : cp);
		});
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
		await this.restoreWithRecovery(checkpoint, root, options, retainRecovery => new FileSnapshotStore(root, this.fileStorageRoot(), message => this.host.notifier.warn(message)).restore(checkpoint.fileSnapshot!, async files => {
			const preview = files.slice(0, 20).map(file => `  ${file}`).join('\n');
			const confirmed = await this.host.confirmRestore(`Restore ${files.length} changed paths? A recovery checkpoint will retain the current files. Dependencies and VCS internals are excluded.\n${preview}${files.length > 20 ? '\n  …' : ''}${options.conversationToo ? '\nThe conversation will also be rewound.' : ''}`);
			if (this.getWorkspaceRoot() !== root) { throw new Error('Workspace changed while confirming restore.'); }
			return confirmed;
		}, retainRecovery));
	}

	private async restoreWithRecovery(
		checkpoint: Checkpoint, root: string, options: RestoreOptions,
		restore: (retain: (snapshot: FileSnapshot | GitSnapshot, markRetained: () => void) => Promise<void>) => Promise<FileSnapshot | GitSnapshot | undefined>,
	): Promise<void> {
		let recoveryCheckpoint: Checkpoint | undefined; let recoveryIndexed = false;
		const protectedIds = new Set([checkpoint.id]);
		const pin = await this.indexStore(root).pin(checkpoint.id, current => {
			if (!options.conversationId || !((!current.ownerDeleted && current.conversationId === options.conversationId) || current.branchConversationIds?.includes(options.conversationId))) { throw new Error('Checkpoint is no longer associated with this conversation.'); }
			if (JSON.stringify(current.snapshot ?? current.fileSnapshot) !== JSON.stringify(checkpoint.snapshot ?? checkpoint.fileSnapshot)) { throw new Error('Checkpoint changed before restore. Please open its preview again.'); }
		});
		this.activeRestores.add(protectedIds);
		try {
			const recovery = await restore(async (snapshot, markRetained) => {
				const strategy = 'commit' in snapshot ? { kind: 'git' as const, snapshot, gitSha: snapshot.commit, baseRef: snapshot.head } : { kind: 'fs' as const, fileSnapshot: snapshot };
				recoveryCheckpoint = {
					id: randomUUID(), conversationId: options.conversationId ?? checkpoint.conversationId, turnIndex: this.conversationStore.load(options.conversationId ?? checkpoint.conversationId)?.messages.length ?? checkpoint.turnIndex,
					capturedAt: Date.now(), userMessage: 'Recovery point before checkpoint restore', summary: 'Recovery point before restore', ...strategy,
				};
				protectedIds.add(recoveryCheckpoint.id); await pin.add(recoveryCheckpoint.id);
				try {
					await this.mutateIndex((index, pinned) => this.pruneIndex([...index, recoveryCheckpoint!], pinned), root, () => { recoveryIndexed = true; markRetained(); });
				} catch (error) {
					if (!recoveryIndexed) { if (error instanceof CheckpointIndexCommitUncertainError) { markRetained(); } throw new Error('Restore cancelled because its recovery checkpoint could not be saved. The workspace files were not changed; try again after history storage is available.', { cause: error }); }
					this.warnRestoreCleanup(error);
				}
				// A subscriber failure cannot make a snapshot store discard indexed recovery.
				try { this._onDidChange.fire(); } catch { /* The durable index remains authoritative. */ }
				if (this.getWorkspaceRoot() !== root) { throw new Error('Workspace changed while saving restore recovery.'); }
			});
			if (!recovery) { return; }
			protectedIds.delete(checkpoint.id);
			try { await pin.remove(checkpoint.id); } catch (error) { this.warnRestoreCleanup(error); }
			// Retain recovery through final pruning even if a newer capture arrived
			// during restore. This may exceed the count by one until a later capture.
			try { await this.mutateIndex((index, pinned) => this.pruneIndex(index, pinned), root); }
			catch (error) { this.warnRestoreCleanup(error); }
			if (options.conversationToo) { this.rewindConversation(checkpoint, options.conversationId); }
			try { this._onDidChange.fire(); } catch { /* Display listeners cannot undo a completed restore. */ }
			try { this.host.notifier.info('Workspace restored. The previous state is available as a recovery checkpoint.'); } catch { /* The durable recovery remains available. */ }
		} finally { this.activeRestores.delete(protectedIds); try { await pin.release(); } catch (error) { this.warnRestoreCleanup(error); } }
	}

	private warnRestoreCleanup(error: unknown): void {
		try { this.host.notifier.warn(`The restore recovery checkpoint is saved, but checkpoint cleanup failed: ${String(error)}`); }
		catch { /* Reporting must not change whether a recovery snapshot is retained. */ }
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
			undefined, undefined, undefined, record.writeToken,
		);
	}

	private keyForIdentity(workspaceRoot: string): string {
		return `${CHECKPOINT_INDEX_KEY}.${workspaceRoot === 'no-workspace' ? 'no-workspace' : createHash('sha256').update(workspaceRoot).digest('hex')}`;
	}

	private indexStore(root = this.getWorkspaceRoot()): CheckpointIndexStorage {
		return this.indexForIdentity(root ? fs.realpathSync.native(root) : 'no-workspace');
	}

	/** Stored identities are canonical already; cleanup never needs to reopen their workspace. */
	private indexForIdentity(workspaceRoot: string): CheckpointIndexStorage {
		let storage = this.indexes.get(workspaceRoot);
		if (!storage) {
			const key = this.keyForIdentity(workspaceRoot);
			storage = new CheckpointIndexStorage(this.fileStorageRoot(), workspaceRoot,
				() => this.globalState.get<Checkpoint[]>(key) ?? [], message => this.host.notifier.warn(message));
			this.indexes.set(workspaceRoot, storage);
		}
		return storage;
	}

	private readIndex(): Checkpoint[] { return this.indexStore().read(); }

	private enqueue(action: () => Promise<void>): Promise<void> {
		const operation = this.pendingWrite.then(action);
		this.pendingWrite = operation.catch(() => { /* Allow the next persistence attempt after a failure. */ });
		return operation;
	}

	private mutateIndex(update: (index: Checkpoint[], pinned: ReadonlySet<string>) => Checkpoint[], root = this.getWorkspaceRoot(), onPersisted?: () => void): Promise<void> {
		const storage = this.indexStore(root);
		return this.enqueue(async () => { await storage.mutate(update, onPersisted); await this.cleanupIndex(storage); });
	}

	private async cleanupIndex(storage: CheckpointIndexStorage): Promise<void> {
		await storage.cleanup(async removed => {
			if (removed.fileSnapshot) { await new FileSnapshotStore(removed.fileSnapshot.workspaceRoot, removed.fileSnapshot.storageRoot).release(removed.fileSnapshot); }
			if (removed.snapshot) { await new GitSnapshotStore(removed.snapshot.workspaceRoot).release(removed.snapshot); }
		});
	}

	private pruneIndex(index: Checkpoint[], pinned: ReadonlySet<string> = new Set()): Checkpoint[] {
		const restoring = new Set([...pinned, ...[...this.activeRestores].flatMap(ids => [...ids])]);
		const retained = index.filter(checkpoint => checkpoint.branchConversationIds?.length || restoring.has(checkpoint.id));
		return [...retained, ...index.filter(checkpoint => !checkpoint.branchConversationIds?.length && !restoring.has(checkpoint.id)).reverse().sort((a, b) => b.capturedAt - a.capturedAt).slice(0, this.getMaxCount())];
	}

}
