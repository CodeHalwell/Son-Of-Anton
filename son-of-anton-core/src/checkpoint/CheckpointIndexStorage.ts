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

interface Index { version: 1; workspaceRoot: string; checkpoints: Checkpoint[]; importedLegacyIds: string[]; deletedConversationIds: string[] }
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
		storageRoot: string, private readonly workspaceRoot: string,
		private readonly legacy: () => readonly Checkpoint[],
		private readonly report: (message: string) => void,
	) {
		this.directory = path.join(storageRoot, 'index-v1', createHash('sha256').update(workspaceRoot).digest('hex'));
		this.file = path.join(this.directory, 'index.json');
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
		const ids = new Set<string>();
		for (const checkpoint of value.checkpoints) { this.validateCheckpoint(checkpoint); if (ids.has(checkpoint.id)) { throw new Error('Duplicate checkpoint index entry.'); } ids.add(checkpoint.id); }
		return value;
	}
	private load(): Index {
		try {
			const index = this.readDisk() ?? { version: 1 as const, workspaceRoot: this.workspaceRoot, checkpoints: [], importedLegacyIds: [], deletedConversationIds: [] };
			const imported = new Set(index.importedLegacyIds); const deleted = new Set(index.deletedConversationIds); const existing = new Set(index.checkpoints.map(checkpoint => checkpoint.id));
			const legacy = this.legacy(); if (!Array.isArray(legacy)) { throw new Error('Invalid legacy checkpoint index.'); }
			for (const checkpoint of legacy as readonly Checkpoint[]) {
				if (checkpoint && imported.has(checkpoint.id)) { continue; }
				this.validateCheckpoint(checkpoint); imported.add(checkpoint.id);
				const ownerDeleted = checkpoint.ownerDeleted || deleted.has(checkpoint.conversationId);
				const branchConversationIds = checkpoint.branchConversationIds?.filter(id => !deleted.has(id));
				if (!existing.has(checkpoint.id)) {
					index.checkpoints.push({ ...checkpoint, ...(ownerDeleted ? { ownerDeleted: true } : {}), ...(branchConversationIds ? { branchConversationIds } : {}) }); existing.add(checkpoint.id);
				}
			}
			index.importedLegacyIds = [...imported]; return index;
		} catch (error) {
			this.warn(`Checkpoint history could not be read. Existing files were preserved: ${this.file}`);
			throw new Error('Checkpoint history is unavailable; its stored index was preserved for recovery.', { cause: error });
		}
	}
	read(): Checkpoint[] { return this.load().checkpoints.filter(checkpoint => !checkpoint.ownerDeleted || checkpoint.branchConversationIds?.length); }
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
		return withCheckpointLock(this.directory, async () => {
			const index = this.load(); const previous = index.checkpoints; const pinned = this.pins(); const next = update([...previous], pinned).filter(checkpoint => !checkpoint.ownerDeleted || checkpoint.branchConversationIds?.length);
			const deleted = new Set(index.deletedConversationIds); if (deletedConversationId) { deleted.add(deletedConversationId); }
			const nextIds = new Set<string>();
			for (const checkpoint of next) {
				this.validateCheckpoint(checkpoint); if (nextIds.has(checkpoint.id)) { throw new Error('Duplicate checkpoint index entry.'); } nextIds.add(checkpoint.id);
				if ((!checkpoint.ownerDeleted && deleted.has(checkpoint.conversationId)) || checkpoint.branchConversationIds?.some(id => deleted.has(id))) { throw new Error('This conversation was permanently deleted. Its checkpoints cannot be recreated or linked again.'); }
			}
			if (previous.some(checkpoint => pinned.has(checkpoint.id) && !next.some(retained => retained.id === checkpoint.id))) { throw new Error('A checkpoint is being restored in another window. Retry after that restore finishes.'); }
			await this.write({ ...index, checkpoints: next, deletedConversationIds: [...deleted] }); onCommitted?.();
			return { previous, next };
		}, message => this.warn(message));
	}
	async pin(id: string, validate?: (checkpoint: Checkpoint) => void): Promise<CheckpointPin> {
		if (!validId(id)) { throw new Error('Invalid checkpoint restore identifier.'); }
		const ids = new Set([id]); const owned = path.join(this.directory, `.pin-${process.pid}-${randomUUID()}`); let released = false;
		try { await withCheckpointLock(this.directory, async () => {
			const checkpoint = this.load().checkpoints.find(checkpoint => checkpoint.id === id);
			if (!checkpoint) { throw new Error('Checkpoint is no longer available.'); } validate?.(checkpoint);
			await atomicCheckpointWrite(owned, JSON.stringify([...ids]));
		}, message => this.warn(message)); } catch (error) {
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
