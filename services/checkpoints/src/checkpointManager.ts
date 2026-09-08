/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Son-Of-Anton Contributors. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { workspacePath, readWorkspaceFile, writeWorkspaceFile, removeWorkspaceFile } from '../_shared/auth/dist/workspaceFs.js';
import type { Checkpoint, CheckpointCreateRequest, CheckpointFile, RetentionPolicy } from './types.js';
import { CheckpointStorage } from './storage.js';

const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
	sessionRetentionDays: 7,
	compressOnSessionEnd: false,
};

export class CheckpointManager {
	private readonly storage: CheckpointStorage;
	private readonly workspaceRoot: string;
	private readonly retentionPolicy: RetentionPolicy;

	constructor(
		storage: CheckpointStorage,
		workspaceRoot: string,
		retentionPolicy: RetentionPolicy = DEFAULT_RETENTION_POLICY
	) {
		this.storage = storage;
		this.workspaceRoot = workspaceRoot;
		this.retentionPolicy = retentionPolicy;
	}

	async createCheckpoint(sessionId: string, request: CheckpointCreateRequest): Promise<Checkpoint> {
		await this.storage.ensureSessionDir(sessionId);

		const files: CheckpointFile[] = [];
		const workspaceRootResolved = await fs.realpath(this.workspaceRoot);

		for (const filePath of request.filePaths) {
			const content = await readWorkspaceFile(workspaceRootResolved, filePath);
			const exists = content !== undefined;
			const contentHash = exists ? crypto.createHash('sha256').update(content).digest('hex') : '';
			if (exists) { await this.storage.saveFileSnapshot(sessionId, contentHash, content); }

			files.push({
				path: filePath,
				contentHash,
				content: null, // Content stored separately via deduplication
				exists,
			});
		}

		const checkpoint: Checkpoint = {
			id: `cp-${crypto.randomUUID()}`,
			timestamp: Date.now(),
			agentId: request.agentId,
			taskId: request.taskId,
			action: request.action,
			toolCall: request.toolCall,
			files,
			metadata: request.metadata ?? {},
			workspaceRoot: workspaceRootResolved,
		};

		await this.storage.saveCheckpoint(sessionId, checkpoint);

		const manifest = await this.storage.loadManifest(sessionId);
		manifest.checkpoints.push(checkpoint.id);
		await this.storage.updateManifest(sessionId, manifest);

		return checkpoint;
	}

	async restoreCheckpoint(sessionId: string, checkpointId: string): Promise<void> {
		const checkpoint = await this.storage.loadCheckpoint(sessionId, checkpointId);
		const root = await fs.realpath(this.workspaceRoot);
		if (checkpoint.workspaceRoot !== root) {
			throw new Error('Checkpoint has no matching workspace identity');
		}
		// Validate the complete plan and load every snapshot before any writes.
		const plan = await Promise.all(checkpoint.files.map(async file => ({
			path: await workspacePath(root, file.path),
			content: file.exists ? await this.storage.loadFileSnapshot(sessionId, file.contentHash) : undefined,
		})));
		const recovery = await Promise.all(plan.map(async file => ({
			path: file.path, content: await readWorkspaceFile(root, file.path),
		})));
		const apply = async (files: typeof plan): Promise<void> => {
			for (const file of files) {
				if (file.content === undefined) { await removeWorkspaceFile(root, file.path); }
				else { await writeWorkspaceFile(root, file.path, file.content); }
			}
		};
		try { await apply(plan); }
		catch (error) {
			await apply(recovery);
			throw error;
		}
	}

	async listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
		const manifest = await this.storage.loadManifest(sessionId);
		const checkpoints: Checkpoint[] = [];

		for (const checkpointId of manifest.checkpoints) {
			const checkpoint = await this.storage.loadCheckpoint(sessionId, checkpointId);
			checkpoints.push(checkpoint);
		}

		return checkpoints;
	}

	async getCheckpoint(sessionId: string, checkpointId: string): Promise<Checkpoint> {
		return this.storage.loadCheckpoint(sessionId, checkpointId);
	}

	/**
	 * Delete a session and all of its checkpoints/file snapshots.
	 * Idempotent — removing a non-existent session is a no-op.
	 */
	async deleteSession(sessionId: string): Promise<void> {
		await this.storage.deleteSession(sessionId);
	}

	async cleanupExpiredSessions(): Promise<number> {
		return this.storage.cleanExpiredSessions(this.retentionPolicy.sessionRetentionDays);
	}
}
