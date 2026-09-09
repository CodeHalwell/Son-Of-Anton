/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Checkpoint } from './CheckpointManager';
import { atomicCheckpointWrite, processOwnerAlive, readCheckpointMetadata, withCheckpointLock } from './ProcessFileLock';

interface Index { version: 1; workspaceRoot: string; checkpoints: Checkpoint[]; importedLegacyIds: string[]; deletedConversationIds: string[]; pendingCleanup?: Checkpoint[] }
export class CheckpointIndexCommitUncertainError extends Error {}
export interface CheckpointPin { add(id: string): Promise<void>; remove(id: string): Promise<void>; release(): Promise<void> }
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const PIN = /^\.pin-\d+-[a-f0-9-]+$/;
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;

/** Shared authoritative index. Memento is only a migration source, never a write destination. */
export class CheckpointIndexStorage {
	private readonly directory: string;
	private readonly file: string;
	private readonly abandonedPins = new Set<string>();
	constructor(
		private readonly storageRoot: string, private readonly workspaceRoot: string,
		private readonly legacy: () => readonly Checkpoint[],
		private readonly report: (message: string) => void,
	) {
		this.directory = path.join(storageRoot, 'index-v1', createHash('sha256').update(workspaceRoot).digest('hex'));
		this.file = path.join(this.directory, 'index.json');
	}
	private static globalDirectory(storageRoot: string): string { return path.join(storageRoot, 'index-v1', '.lifecycle'); }
	private static deleted(storageRoot: string): Set<string> {
		let body: string;
		try { body = readCheckpointMetadata(path.join(this.globalDirectory(storageRoot), 'deleted.json'), MAX_INDEX_BYTES); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return new Set(); } throw error; }
		const value: unknown = JSON.parse(body);
		if (!Array.isArray(value) || value.some(id => !validId(id))) { throw new Error('Invalid global checkpoint deletion record.'); }
		return new Set(value as string[]);
	}
	/** Commits the global barrier before enumerating indexes; every writer uses the same lock. */
	static async markDeleted(storageRoot: string, conversationId: string, report: (message: string) => void): Promise<void> {
		if (!validId(conversationId)) { throw new Error('Invalid conversation deletion identifier.'); }
		const warn = (message: string) => { try { report(message); } catch { /* Preserve the committed outcome. */ } };
		await withCheckpointLock(this.globalDirectory(storageRoot), async () => {
			const deleted = this.deleted(storageRoot); if (deleted.has(conversationId)) { return; } deleted.add(conversationId);
			const body = JSON.stringify([...deleted]); if (Buffer.byteLength(body) > MAX_INDEX_BYTES) { throw new Error('Global checkpoint deletion record exceeds its safe storage limit.'); }
			let committed = false;
			try { await atomicCheckpointWrite(path.join(this.globalDirectory(storageRoot), 'deleted.json'), body, () => { committed = true; }); }
			catch (error) { if (!committed && !this.deleted(storageRoot).has(conversationId)) { throw error; } warn(`Checkpoint deletion was recorded, but temporary cleanup failed: ${String(error)}`); }
		}, warn);
	}
	/** Reads only bounded index metadata; original workspace directories need not exist. */
	static async discover(storageRoot: string): Promise<{ roots: string[]; errors: unknown[] }> {
		const roots: string[] = []; const errors: unknown[] = []; let directory: fs.Dir;
		try { directory = await fsp.opendir(path.join(storageRoot, 'index-v1')); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return { roots, errors }; } throw error; }
		for await (const entry of directory) {
			if (!/^[a-f0-9]{64}$/.test(entry.name)) { continue; }
			try {
				if (!entry.isDirectory() || entry.isSymbolicLink()) { throw new Error('Invalid checkpoint index directory.'); }
				const file = path.join(storageRoot, 'index-v1', entry.name, 'index.json'); let body: string;
				try { body = readCheckpointMetadata(file, MAX_INDEX_BYTES); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
				const value = JSON.parse(body) as { workspaceRoot?: unknown };
				if (typeof value?.workspaceRoot !== 'string' || (value.workspaceRoot !== 'no-workspace' && (!path.isAbsolute(value.workspaceRoot) || path.normalize(value.workspaceRoot) !== value.workspaceRoot)) || createHash('sha256').update(value.workspaceRoot).digest('hex') !== entry.name) { throw new Error('Checkpoint index workspace identity does not match its directory.'); }
				roots.push(value.workspaceRoot);
			} catch (error) { errors.push(error); }
			await new Promise<void>(resolve => setImmediate(resolve));
		}
		return { roots, errors };
	}
	private warn(message: string): void { try { this.report(message); } catch { /* Diagnostics cannot alter a durable commit. */ } }
	private validateCheckpoint(value: Checkpoint): void {
		if (!value || !validId(value.id) || !validId(value.conversationId) || !Number.isSafeInteger(value.turnIndex) || value.turnIndex < 0 || !Number.isFinite(value.capturedAt) || typeof value.userMessage !== 'string' || !['git', 'fs'].includes(value.kind)
			|| (value.branchConversationIds !== undefined && (!Array.isArray(value.branchConversationIds) || value.branchConversationIds.some(id => !validId(id))))
			|| (value.ownerDeleted !== undefined && typeof value.ownerDeleted !== 'boolean')) { throw new Error('Invalid checkpoint index entry.'); }
		if (value.fileSnapshot && (value.kind !== 'fs' || value.fileSnapshot.version !== 1 || value.fileSnapshot.workspaceRoot !== this.workspaceRoot || typeof value.fileSnapshot.storageRoot !== 'string' || !validId(value.fileSnapshot.id) || typeof value.fileSnapshot.rootIdentity !== 'string')) { throw new Error('Invalid file checkpoint index entry.'); }
		if (value.snapshot && (value.kind !== 'git' || value.snapshot.version !== 1 || value.snapshot.workspaceRoot !== this.workspaceRoot || typeof value.snapshot.gitDir !== 'string' || typeof value.snapshot.ref !== 'string' || typeof value.snapshot.head !== 'string' || typeof value.snapshot.commit !== 'string' || typeof value.snapshot.indexTree !== 'string')) { throw new Error('Invalid Git checkpoint index entry.'); }
	}
	private readDisk(): Index | undefined {
		let body: string;
		try { body = readCheckpointMetadata(this.file, MAX_INDEX_BYTES); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }

		const value = JSON.parse(body) as Index;
		if (value?.version !== 1 || value.workspaceRoot !== this.workspaceRoot || !Array.isArray(value.checkpoints) || !Array.isArray(value.importedLegacyIds) || value.importedLegacyIds.some(id => !validId(id)) || !Array.isArray(value.deletedConversationIds) || value.deletedConversationIds.some(id => !validId(id))) { throw new Error('Invalid checkpoint index.'); }
		if (value.pendingCleanup !== undefined && !Array.isArray(value.pendingCleanup)) { throw new Error('Invalid checkpoint cleanup record.'); }
		const cleanupIds = new Set<string>();
		for (const checkpoint of value.pendingCleanup ?? []) { this.validateCheckpoint(checkpoint); if (cleanupIds.has(checkpoint.id)) { throw new Error('Duplicate checkpoint cleanup record.'); } cleanupIds.add(checkpoint.id); }
		const ids = new Set<string>();
		for (const checkpoint of value.checkpoints) { this.validateCheckpoint(checkpoint); if (ids.has(checkpoint.id) || cleanupIds.has(checkpoint.id)) { throw new Error('Duplicate checkpoint index entry.'); } ids.add(checkpoint.id); }
		return value;
	}
	private load(): Index {
		try {
			const index = this.readDisk() ?? { version: 1 as const, workspaceRoot: this.workspaceRoot, checkpoints: [], importedLegacyIds: [], deletedConversationIds: [] };
			const imported = new Set(index.importedLegacyIds); const deleted = new Set([...index.deletedConversationIds, ...CheckpointIndexStorage.deleted(this.storageRoot)]); const existing = new Set(index.checkpoints.map(checkpoint => checkpoint.id));
			const legacy = this.legacy(); if (!Array.isArray(legacy)) { throw new Error('Invalid legacy checkpoint index.'); }
			for (const checkpoint of legacy as readonly Checkpoint[]) {
				if (checkpoint && imported.has(checkpoint.id)) { continue; }
				this.validateCheckpoint(checkpoint); imported.add(checkpoint.id);
				if (!existing.has(checkpoint.id)) {
					index.checkpoints.push({ ...checkpoint }); existing.add(checkpoint.id);
				}
			}
			index.importedLegacyIds = [...imported];
			index.deletedConversationIds = [...deleted];
			return index;
		} catch (error) {
			this.warn(`Checkpoint history could not be read. Existing files were preserved: ${this.file}`);
			throw new Error('Checkpoint history is unavailable; its stored index was preserved for recovery.', { cause: error });
		}
	}
	private withoutDeleted(checkpoints: Checkpoint[], deleted: ReadonlySet<string>): Checkpoint[] {
		return checkpoints.map(checkpoint => ({ ...checkpoint,
			...(deleted.has(checkpoint.conversationId) ? { ownerDeleted: true } : {}),
			...(checkpoint.branchConversationIds ? { branchConversationIds: checkpoint.branchConversationIds.filter(id => !deleted.has(id)) } : {}),
		})).filter(checkpoint => !checkpoint.ownerDeleted || checkpoint.branchConversationIds?.length);
	}
	read(): Checkpoint[] { const index = this.load(); return this.withoutDeleted(index.checkpoints, new Set(index.deletedConversationIds)); }
	private async write(index: Index): Promise<void> {
		const body = JSON.stringify(index); if (Buffer.byteLength(body) > MAX_INDEX_BYTES) { throw new Error('Checkpoint index exceeds its safe storage limit.'); }
		let committed = false;
		try { await atomicCheckpointWrite(this.file, body, () => { committed = true; }); }
		catch (error) {
			if (!committed) {
				let current: Index | undefined;
				try { current = this.readDisk(); }
				catch (verificationError) { throw new CheckpointIndexCommitUncertainError(`Checkpoint index commit could not be verified. Snapshot files were retained; recover the index at ${this.file}.`, { cause: new AggregateError([error, verificationError]) }); }
				if (JSON.stringify(current) !== body) { throw error; }
			}
			this.warn(`Checkpoint index was saved, but temporary cleanup failed: ${String(error)}`);
		}
	}
	private pins(): Set<string> {
		const ids = new Set<string>();
		for (const file of this.abandonedPins) { try { fs.rmSync(file, { force: true }); this.abandonedPins.delete(file); } catch { /* Keep protecting its snapshots until cleanup can be retried. */ } }
		for (const name of fs.readdirSync(this.directory)) {
			if (!PIN.test(name)) { continue; }
			const file = path.join(this.directory, name);
			if (!processOwnerAlive(name)) { fs.rmSync(file, { force: true }); continue; }
			let values: unknown;
			try { values = JSON.parse(readCheckpointMetadata(file, 1024 * 1024)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
			if (!Array.isArray(values) || values.length > 1000 || values.some(id => !validId(id))) { throw new Error('Invalid active checkpoint restore record.'); }
			for (const id of values) { ids.add(id as string); }
		}
		return ids;
	}
	async mutate(update: (index: Checkpoint[], pinned: ReadonlySet<string>) => Checkpoint[], onCommitted?: () => void, deletedConversationId?: string): Promise<{ previous: Checkpoint[]; next: Checkpoint[] }> {
		if (deletedConversationId !== undefined && !validId(deletedConversationId)) { throw new Error('Invalid conversation deletion identifier.'); }
		return withCheckpointLock(CheckpointIndexStorage.globalDirectory(this.storageRoot), () => withCheckpointLock(this.directory, async () => {
			const index = this.load(); const previous = index.checkpoints; const pinned = this.pins(); const requested = update([...previous], pinned);
			const deleted = new Set(index.deletedConversationIds); if (deletedConversationId) { deleted.add(deletedConversationId); }
			for (const checkpoint of requested) {
				this.validateCheckpoint(checkpoint);
				const prior = previous.find(value => value.id === checkpoint.id);
				if ((!checkpoint.ownerDeleted && deleted.has(checkpoint.conversationId) && prior?.conversationId !== checkpoint.conversationId) || checkpoint.branchConversationIds?.some(id => deleted.has(id) && !prior?.branchConversationIds?.includes(id))) { throw new Error('This conversation was permanently deleted. Its checkpoints cannot be recreated or linked again.'); }
			}
			const next = this.withoutDeleted(requested, deleted);
			const nextIds = new Set<string>();
			for (const checkpoint of next) {
				this.validateCheckpoint(checkpoint); if (nextIds.has(checkpoint.id)) { throw new Error('Duplicate checkpoint index entry.'); } nextIds.add(checkpoint.id);
				if ((!checkpoint.ownerDeleted && deleted.has(checkpoint.conversationId)) || checkpoint.branchConversationIds?.some(id => deleted.has(id))) { throw new Error('This conversation was permanently deleted. Its checkpoints cannot be recreated or linked again.'); }
			}
			if (previous.some(checkpoint => pinned.has(checkpoint.id) && !next.some(retained => retained.id === checkpoint.id))) { throw new Error('A checkpoint is being restored in another window. Retry after that restore finishes.'); }
			const cleanup = new Map((index.pendingCleanup ?? []).map(checkpoint => [checkpoint.id, checkpoint]));
			for (const checkpoint of previous) { if (!nextIds.has(checkpoint.id)) { cleanup.set(checkpoint.id, checkpoint); } }
			if (next.some(checkpoint => cleanup.has(checkpoint.id))) { throw new Error('A removed checkpoint cannot be recreated.'); }
			await this.write({ ...index, checkpoints: next, deletedConversationIds: [...deleted], pendingCleanup: [...cleanup.values()] }); onCommitted?.();
			return { previous, next };
		}, message => this.warn(message)), message => this.warn(message));
	}
	/** Payload descriptors survive removal until physical cleanup succeeds, including across restarts. */
	async cleanup(release: (checkpoint: Checkpoint) => Promise<void>): Promise<void> {
		await withCheckpointLock(this.directory, async () => {
			const index = this.readDisk(); if (!index?.pendingCleanup?.length) { return; }
			const pending: Checkpoint[] = []; const errors: unknown[] = [];
			for (const checkpoint of index.pendingCleanup) {
				try { await release(checkpoint); } catch (error) { pending.push(checkpoint); errors.push(error); }
			}
			if (pending.length !== index.pendingCleanup.length) { await this.write({ ...index, pendingCleanup: pending }); }
			if (errors.length) { throw new AggregateError(errors, 'Checkpoint payload cleanup is incomplete. Its records were retained for retry.'); }
		}, message => this.warn(message));
	}
	async pin(id: string, validate?: (checkpoint: Checkpoint) => void): Promise<CheckpointPin> {
		if (!validId(id)) { throw new Error('Invalid checkpoint restore identifier.'); }
		const ids = new Set([id]); const owned = path.join(this.directory, `.pin-${process.pid}-${randomUUID()}`); let released = false;
		try { await withCheckpointLock(CheckpointIndexStorage.globalDirectory(this.storageRoot), () => withCheckpointLock(this.directory, async () => {
			const checkpoint = this.read().find(checkpoint => checkpoint.id === id);
			if (!checkpoint) { throw new Error('Checkpoint is no longer available.'); } validate?.(checkpoint);
			await atomicCheckpointWrite(owned, JSON.stringify([...ids]));
		}, message => this.warn(message)), message => this.warn(message)); } catch (error) {
			try { await fsp.rm(owned, { force: true }); } catch { this.abandonedPins.add(owned); this.warn(`An unused checkpoint restore pin could not be removed: ${owned}`); }
			throw error;
		}
		const change = (update: () => void): Promise<void> => withCheckpointLock(this.directory, async () => { if (released) { throw new Error('Checkpoint restore has already finished.'); } update(); await atomicCheckpointWrite(owned, JSON.stringify([...ids])); }, message => this.warn(message));
		return {
			add: id => change(() => { if (!validId(id) || (!ids.has(id) && ids.size >= 1000)) { throw new Error('Invalid checkpoint restore identifier.'); } ids.add(id); }), remove: id => change(() => { ids.delete(id); }),
			release: async () => { if (!released) { try { await withCheckpointLock(this.directory, async () => { await fsp.rm(owned, { force: true }); released = true; }, message => this.warn(message)); } catch (error) { this.abandonedPins.add(owned); throw error; } } },
		};
	}
}
