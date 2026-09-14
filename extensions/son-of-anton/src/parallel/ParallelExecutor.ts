/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ParallelExecutor — coordinates parallel agent execution using
 * scope locks and git worktrees.
 *
 * Integrates the ScopeLockManager (file-level locking) with the
 * WorktreeManager (isolated git worktrees) to allow multiple agents
 * to work concurrently on non-overlapping file sets.
 */

import { ScopeLockManager } from './ScopeLockManager';
import { WorktreeManager, MergeResult } from './WorktreeManager';

export interface ParallelTask {
	id: string;
	agentId: string;
	instruction: string;
	scopeFiles: string[];
	dependencies: string[];
}

export interface ParallelTaskResult {
	taskId: string;
	agentId: string;
	success: boolean;
	mergeResult?: MergeResult;
	error?: string;
	proposalId?: string;
	reviewRequired?: boolean;
}

export interface ExecutionGroup {
	/** Tasks that can run in parallel */
	parallel: ParallelTask[];
	/** Tasks that must wait for the parallel group to finish */
	serialized: ParallelTask[];
	/** Reason for serialization */
	serializationReasons: Map<string, string>;
}

export interface ParallelExecutorOptions {
	repoRoot: string;
	lockHost: string;
	lockPort: number;
	maxConcurrent?: number;
	lockTtlMs?: number;
	conflictCheckIntervalMs?: number;
}

const DEFAULT_CONFLICT_CHECK_INTERVAL_MS = 15_000;

export class ParallelExecutor {
	private readonly lockManager: ScopeLockManager;
	private readonly worktreeManager: WorktreeManager;
	private readonly conflictCheckIntervalMs: number;

	private disposed = false;
	private checking = false;
	private conflictCheckTimer: ReturnType<typeof setInterval> | undefined;
	private readonly activeExecutions = new Map<string, ParallelTask>();

	constructor(options: ParallelExecutorOptions) {
		this.lockManager = new ScopeLockManager({
			host: options.lockHost,
			port: options.lockPort,
			defaultTtlMs: options.lockTtlMs,
		});

		this.worktreeManager = new WorktreeManager({
			repoRoot: options.repoRoot,
			maxConcurrent: options.maxConcurrent,
		});

		this.conflictCheckIntervalMs = options.conflictCheckIntervalMs ?? DEFAULT_CONFLICT_CHECK_INTERVAL_MS;

		// Register deadlock handler
		this.lockManager.onDeadlock((agents) => {
			console.warn(`[ParallelExecutor] Deadlock detected between agents: ${agents.join(', ')}`);
			// Cancel the last agent in the cycle to break the deadlock
			const agentToCancel = agents[agents.length - 1];
			this.lockManager.releaseLock(agentToCancel);
		});
	}

	/**
	 * Analyze a set of tasks and determine which can run in parallel.
	 * Tasks with overlapping scope files are serialized.
	 */
	planExecution(tasks: ParallelTask[]): ExecutionGroup {
		const parallel: ParallelTask[] = [];
		const serialized: ParallelTask[] = [];
		const reasons = new Map<string, string>();

		// Track files claimed by parallel tasks
		const claimedFiles = new Map<string, string>(); // file -> taskId

		for (const task of tasks) {
			// Check if task has unsatisfied dependencies on other tasks in this batch
			const hasDeps = task.dependencies.some(depId =>
				tasks.some(t => t.id === depId)
			);

			if (hasDeps) {
				serialized.push(task);
				reasons.set(task.id, `Depends on: ${task.dependencies.join(', ')}`);
				continue;
			}

			// Check for scope overlap with already-parallel tasks
			const overlapping = task.scopeFiles.filter(f => claimedFiles.has(f));
			if (overlapping.length > 0) {
				serialized.push(task);
				const conflictingTask = claimedFiles.get(overlapping[0])!;
				reasons.set(task.id,
					`File overlap with ${conflictingTask}: ${overlapping.join(', ')}`
				);
				continue;
			}

			// Check for conflicts with existing locks
			const lockConflicts = this.lockManager.checkConflict(task.scopeFiles);
			if (lockConflicts.length > 0) {
				serialized.push(task);
				reasons.set(task.id,
					`Lock conflict: ${lockConflicts.map(c => `${c.file} held by ${c.heldBy}`).join(', ')}`
				);
				continue;
			}

			// Task can run in parallel
			parallel.push(task);
			for (const file of task.scopeFiles) {
				claimedFiles.set(file, task.id);
			}
		}

		return { parallel, serialized, serializationReasons: reasons };
	}

	/**
	 * Execute a task in an isolated worktree with scope locks.
	 * Returns a handle that the caller uses to run the actual agent logic.
	 */
	async prepareExecution(task: ParallelTask): Promise<{
		worktreePath: string;
		execute: (fn: (worktreePath: string) => Promise<void>) => Promise<ParallelTaskResult>;
	}> {
		if (this.disposed) { throw new Error('Parallel executor is disposed'); }
		if (this.activeExecutions.has(task.id)) { throw new Error('Task is already running'); }
		const lockResult = this.lockManager.acquireLock(task.id, task.scopeFiles);
		if (!lockResult.success) { throw new Error(`Lock conflict: ${lockResult.conflicts?.map(conflict => conflict.file).join(', ')}`); }
		let worktree;
		this.activeExecutions.set(task.id, task);
		try { worktree = await this.worktreeManager.createWorktree(task.id); }
		catch (error) { this.activeExecutions.delete(task.id); this.lockManager.releaseLock(task.id); throw error; }
		let executed = false;
		return { worktreePath: worktree.worktreePath, execute: async fn => {
			if (executed || this.disposed) { throw new Error('Execution handle is no longer available'); } executed = true;
			try {
				await fn(worktree.worktreePath);
				const proposal = await this.worktreeManager.finish(task.id);
				return { taskId: task.id, agentId: task.agentId, success: true, proposalId: proposal.id, reviewRequired: true };
			} catch (error) {
				await this.worktreeManager.finish(task.id, true).catch(() => {});
				return { taskId: task.id, agentId: task.agentId, success: false, proposalId: worktree.proposalId, error: String(error) };
			} finally {
				this.lockManager.releaseLock(task.id); this.activeExecutions.delete(task.id);
				await this.worktreeManager.removeWorktree(task.id);
			}
		} };
	}

	/**
	 * Start continuous conflict detection for active parallel agents.
	 * Warns early if agents' changes start overlapping.
	 */
	startConflictDetection(
		onOverlap: (agentA: string, agentB: string, files: string[]) => void,
	): void {
		if (this.conflictCheckTimer) { clearInterval(this.conflictCheckTimer); }
		this.conflictCheckTimer = setInterval(async () => {
			if (this.checking || this.disposed) { return; } this.checking = true;
			try {
			const agents = [...this.activeExecutions.keys()];
			for (let i = 0; i < agents.length; i++) {
				for (let j = i + 1; j < agents.length; j++) {
					try {
						const overlap = await this.worktreeManager.checkOverlap(agents[i], agents[j]);
						if (overlap.length > 0) {
							onOverlap(agents[i], agents[j], overlap);
						}
					} catch {
						// Agent may have finished between check start and now
					}
				}
			}
		} finally { this.checking = false; }
		}, this.conflictCheckIntervalMs);
	}

	/**
	 * Stop conflict detection and cleanup all resources.
	 */
	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.conflictCheckTimer) {
			clearInterval(this.conflictCheckTimer);
		}
		this.lockManager.dispose();
	}

	/**
	 * Get current lock status for display in the agent status sidebar.
	 */
	getLockStatus(): Array<{ agentId: string; files: string[]; acquiredAt: number }> {
		return this.lockManager.listLocks().map(lock => ({
			agentId: lock.agentId,
			files: lock.files,
			acquiredAt: lock.acquiredAt,
		}));
	}
}
