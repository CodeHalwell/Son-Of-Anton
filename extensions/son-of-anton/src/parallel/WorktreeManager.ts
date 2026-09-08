/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IsolatedWorkspace, type WorkspaceProposal } from 'son-of-anton-core/workspace/IsolatedWorkspace';
import { GitSnapshotStore } from 'son-of-anton-core/checkpoint/GitSnapshotStore';
export interface WorktreeInfo {
	/** Unique agent ID that owns this worktree */
	agentId: string;
	/** Branch name for this worktree */
	branch: string;
	/** Absolute path to the worktree directory */
	worktreePath: string;
	/** When the worktree was created */
	createdAt: number;
	/** Files that were changed in this worktree */
	changedFiles: string[];
	proposalId: string;
}

export interface MergeResult {
	success: boolean;
	/** Files that conflicted during merge */
	conflicts: string[];
	/** Human-readable summary of the merge */
	summary: string;
}

export interface WorktreeManagerOptions {
	/** Root directory of the git repository */
	repoRoot: string;
	/** Maximum concurrent worktrees (default: 2) */
	maxConcurrent?: number;
	/** Temp directory for worktrees (default: os.tmpdir()) */
	tempDir?: string;
}


/** Active handles are disposable; retained proposals are never deleted on failure or shutdown. */
export class WorktreeManager {
	private readonly worktrees = new Map<string, WorktreeInfo>();
	private readonly reservations = new Set<string>();
	readonly proposals: IsolatedWorkspace;
	constructor(private readonly options: WorktreeManagerOptions) {
		this.proposals = new IsolatedWorkspace(join(options.tempDir ?? tmpdir(), 'sota-parallel-proposals'));
	}
	async createWorktree(agentId: string): Promise<WorktreeInfo> {
		if (this.reservations.has(agentId) || this.worktrees.has(agentId)) { throw new Error('This task already has a worktree'); }
		if (this.reservations.size + this.worktrees.size >= (this.options.maxConcurrent ?? 2)) { throw new Error('Maximum concurrent worktrees reached'); }
		this.reservations.add(agentId);
		try {
			const proposal = await this.proposals.create(this.options.repoRoot);
			const info = { agentId, branch: proposal.baseline.ref, worktreePath: proposal.worktree, createdAt: Date.now(), changedFiles: [], proposalId: proposal.id };
			this.worktrees.set(agentId, info); return info;
		} finally { this.reservations.delete(agentId); }
	}
	getWorktree(agentId: string): WorktreeInfo | undefined { return this.worktrees.get(agentId); }
	listWorktrees(): WorktreeInfo[] { return [...this.worktrees.values()]; }
	async getChangedFiles(agentId: string): Promise<string[]> {
		const info = this.worktrees.get(agentId); if (!info) { throw new Error('No worktree for this task'); }
		const { stdout } = await promisify(execFile)('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { cwd: info.worktreePath, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))) });
		return info.changedFiles = stdout.split('\0').filter(Boolean).map(line => line.slice(3));
	}
	async checkOverlap(a: string, b: string): Promise<string[]> {
		const [first, second] = await Promise.all([this.getChangedFiles(a), this.getChangedFiles(b)]); const files = new Set(second); return first.filter(file => files.has(file));
	}
	async finish(agentId: string, failed = false): Promise<WorkspaceProposal> {
		const info = this.worktrees.get(agentId); if (!info) { throw new Error('No worktree for this task'); }
		return this.proposals.finish(info.proposalId, failed ? 'failed' : 'review');
	}
	async simulateMerge(agentId: string): Promise<MergeResult> {
		try {
			const proposal = await this.finish(agentId); const snapshots = new GitSnapshotStore(this.options.repoRoot); const current = await snapshots.capture();
			try { const conflicts = await this.proposals.conflicts(proposal, current); return { success: !conflicts.length, conflicts, summary: conflicts.length ? 'Current edits conflict with the proposal.' : 'Proposal can be reviewed.' }; }
			finally { await snapshots.release(current); }
		} catch (error) { return { success: false, conflicts: [], summary: String(error) }; }
	}
	/** Explicit digest from a completed review is required; HEAD and the index remain untouched. */
	async mergeWorktree(agentId: string, _message: string, reviewedDigest?: string): Promise<MergeResult> {
		const info = this.worktrees.get(agentId);
		if (!info || !reviewedDigest) { return { success: false, conflicts: [], summary: 'Review the retained proposal before applying.' }; }
		try { await this.proposals.apply(info.proposalId, reviewedDigest); return { success: true, conflicts: [], summary: 'Reviewed changes applied with a recovery checkpoint.' }; }
		catch (error) { return { success: false, conflicts: [], summary: String(error) }; }
	}
	/** Release an active handle. Files and checkpoint refs remain available for recovery. */
	async removeWorktree(agentId: string): Promise<void> { this.worktrees.delete(agentId); }
	async removeAll(): Promise<void> { this.worktrees.clear(); }
}
