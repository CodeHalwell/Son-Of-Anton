/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { execFile } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, realpath, stat, open, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { GitSnapshotStore, type GitSnapshot } from '../checkpoint/GitSnapshotStore';
import type { ValidationEvidence } from './ProposalValidation';

export interface WorkspaceProposal {
	version: 1;
	id: string;
	workspace: string;
	worktree: string;
	ownerPid: number;
	status: 'running' | 'review' | 'failed' | 'cancelled' | 'interrupted' | 'applying' | 'applied';
	baseline: GitSnapshot;
	result?: GitSnapshot;
	recovery?: GitSnapshot;
	files: string[];
	digest?: string;
	error?: string;
	appliedFiles?: string[];
	applications?: { id: string; files: string[]; recovery: GitSnapshot; restored?: boolean }[];
	validation?: ValidationEvidence;
}

function git(cwd: string, args: string[], input?: Buffer): Promise<string> {
	return new Promise((resolve, reject) => { const child = execFile('git', ['--literal-pathspecs', '-c', 'core.hooksPath=/nonexistent-sota-hooks', ...args], {
		cwd, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
		env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0' },
	}, (error, stdout) => error ? reject(error) : resolve(stdout)); child.stdin?.on('error', () => {}); child.stdin?.end(input); });
}

/** Publish a unique claim before checking competitors. Crashed owners cannot leave a permanent lock. */
async function claimOperation(directory: string, prefix: string): Promise<() => Promise<void>> {
	const name = `${prefix}${process.pid}-${randomUUID()}.lock`;
	const lock = await open(join(directory, name), 'wx', 0o600);
	const release = async () => { await lock.close(); await unlink(join(directory, name)).catch(() => {}); };
	try {
		for (const entry of await readdir(directory)) {
			if (entry === name || !entry.startsWith(prefix)) { continue; }
			const match = /^(\d+)-[a-f0-9-]{36}\.lock$/.exec(entry.slice(prefix.length));
			if (!match) { continue; }
			try { process.kill(Number(match[1]), 0); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') { continue; } }
			throw new Error('Another proposal operation is in progress. Retry after it completes.');
		}
		return release;
	} catch (error) { await release(); throw error; }
}

/** Retained detached workspaces; applying a reviewed patch never moves HEAD or the user's index. */
export class IsolatedWorkspace {
	constructor(readonly directory: string) { }
	private folder(id: string): string {
		if (!/^[a-f0-9-]{36}$/.test(id)) { throw new Error('Invalid workspace proposal ID'); }
		return join(this.directory, id);
	}
	async save(proposal: WorkspaceProposal): Promise<void> {
		const target = join(this.folder(proposal.id), 'proposal.json');
		const temporary = `${target}.${randomUUID()}.tmp`;
		try { await writeFile(temporary, JSON.stringify(proposal), { mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
		finally { await unlink(temporary).catch(() => {}); }
	}
	async load(id: string): Promise<WorkspaceProposal> {
		const file = join(this.folder(id), 'proposal.json');
		if ((await stat(file)).size > 256 * 1024) { throw new Error('Workspace proposal exceeds size limit'); }
		const proposal = JSON.parse(await readFile(file, 'utf8')) as WorkspaceProposal;
		if (proposal.version !== 1 || proposal.id !== id || !proposal.baseline || !Array.isArray(proposal.files)) { throw new Error('Invalid workspace proposal'); }
		if (await realpath(proposal.worktree) !== await realpath(join(this.folder(id), 'workspace'))) { throw new Error('Proposal worktree does not match its retained directory'); }
		if (proposal.validation?.status === 'running') {
			try { process.kill(proposal.validation.ownerPid, 0); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ESRCH') { proposal.validation.status = 'interrupted'; proposal.validation.error = 'The validation host exited before recording a result.'; await this.save(proposal); }
			}
		}
		if (proposal.status === 'running' || proposal.status === 'applying') {
			try { process.kill(proposal.ownerPid, 0); } catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ESRCH') { proposal.status = 'interrupted'; proposal.error = 'The agent process exited. Its isolated files are retained.'; await this.save(proposal); }
			}
		}
		return proposal;
	}
	async create(workspace: string): Promise<WorkspaceProposal> {
		const root = await realpath(workspace);
		const id = randomUUID();
		await mkdir(this.folder(id), { recursive: true, mode: 0o700 });
		const baseline = await new GitSnapshotStore(root).capture();
		const worktree = join(this.folder(id), 'workspace');
		// The snapshot includes existing staged/unstaged/untracked work. HEAD alone would lose that context.
		await git(root, ['worktree', 'add', '--detach', worktree, baseline.commit]);
		const proposal: WorkspaceProposal = { version: 1, id, workspace: root, worktree: await realpath(worktree), ownerPid: process.pid, status: 'running', baseline, files: [] };
		await this.save(proposal);
		return proposal;
	}
	async finish(id: string, status: 'review' | 'failed' | 'cancelled', error?: string): Promise<WorkspaceProposal> {
		const release = await claimOperation(this.folder(id), 'proposal-operation-');
		try { return await this.finishUnlocked(id, status, error); } finally { await release(); }
	}
	private async finishUnlocked(id: string, status: 'review' | 'failed' | 'cancelled', error?: string): Promise<WorkspaceProposal> {
		const proposal = await this.load(id);
		if (proposal.status === 'applied' || proposal.status === 'applying' || proposal.appliedFiles?.length) { throw new Error('This proposal is already applied'); }
		const result = await new GitSnapshotStore(proposal.worktree).capture();
		const files = (await git(proposal.workspace, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', proposal.baseline.commit, result.commit])).split('\0').filter(Boolean);
		if (files.length > 500 || files.some(file => file === '.git' || file.startsWith('.git/'))) { throw new Error('Proposal changed too many files or repository metadata'); }
		const patch = await git(proposal.workspace, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', proposal.baseline.commit, result.commit, '--']);
		if (Buffer.byteLength(patch) > 8 * 1024 * 1024) { throw new Error('Proposed patch exceeds 8 MiB; isolated files are retained'); }
		await writeFile(this.patchPath(id), patch, { mode: 0o600 });
		Object.assign(proposal, { result, files, digest: createHash('sha256').update(patch).digest('hex'), status, error });
		await this.save(proposal);
		return proposal;
	}
	patchPath(id: string): string { return join(this.folder(id), 'changes.patch'); }
	/** Conflicts are checked against all affected preimages, including new/deleted files and modes. */
	async conflicts(proposal: WorkspaceProposal, current: GitSnapshot, files = proposal.files, beforeCommit = proposal.baseline.commit): Promise<string[]> {
		if (current.workspaceRoot !== proposal.workspace || current.head !== proposal.baseline.head) { throw new Error('Workspace or HEAD changed since the task started'); }
		for (const file of files) {
			const rel = relative(proposal.workspace, join(proposal.workspace, file));
			if (!rel || rel.startsWith('..') || isAbsolute(rel)) { throw new Error('Proposal path is outside the workspace'); }
		}
		const entries = async (commit: string) => new Map((await git(proposal.workspace, ['ls-tree', '-r', '-z', commit, '--', ...files])).split('\0').filter(Boolean).map(entry => [entry.slice(entry.indexOf('\t') + 1), entry]));
		const [before, now] = await Promise.all([entries(beforeCommit), entries(current.commit)]);
		return files.filter(file => before.get(file) !== now.get(file));
	}
	private selection(proposal: WorkspaceProposal, selected?: string[]): string[] {
		const remaining = proposal.files.filter(file => !(proposal.appliedFiles ?? []).includes(file));
		const files = [...new Set(selected ?? remaining)].sort();
		if (!files.length || files.some(file => !remaining.includes(file))) { throw new Error('Select unapplied proposal files'); }
		return files;
	}
	private async patch(proposal: WorkspaceProposal, files: string[], reverse = false): Promise<Buffer> {
		if (!proposal.result || createHash('sha256').update(await readFile(this.patchPath(proposal.id))).digest('hex') !== proposal.digest) { throw new Error('Proposed patch changed since review'); }
		const reviewed = await git(proposal.workspace, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', proposal.baseline.commit, proposal.result.commit, '--']);
		if (createHash('sha256').update(reviewed).digest('hex') !== proposal.digest) { throw new Error('Proposal snapshots changed since review'); }
		const commits = [proposal.baseline.commit, proposal.result.commit];
		if (reverse) { commits.reverse(); }
		return Buffer.from(await git(proposal.workspace, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', ...commits, '--', ...files]));
	}
	async fileContent(id: string, side: 'before' | 'after', file: string): Promise<string> {
		const proposal = await this.load(id);
		if (!proposal.files.includes(file) || !proposal.result) { throw new Error('File is unavailable in this proposal'); }
		const commit = side === 'before' ? proposal.baseline.commit : proposal.result.commit;
		if (!(await git(proposal.workspace, ['ls-tree', '-z', commit, '--', file]))) { return ''; }
		const size = Number((await git(proposal.workspace, ['cat-file', '-s', `${commit}:${file}`])).trim());
		if (size > 2 * 1024 * 1024) { throw new Error('File exceeds the 2 MiB preview limit'); }
		const content = await git(proposal.workspace, ['show', `${commit}:${file}`]);
		if (content.includes('\0')) { throw new Error('Binary file: inspect the retained workspace or exported patch'); }
		return content;
	}
	/** Validate a fresh candidate containing only the selected patch on the current workspace. */
	async prepareValidation(id: string, expectedDigest: string, selected?: string[]): Promise<ValidationEvidence> {
		const release = await claimOperation(this.folder(id), 'proposal-operation-');
		try {
			const proposal = await this.load(id);
			if (proposal.status !== 'review' || proposal.digest !== expectedDigest) { throw new Error('Proposal is no longer awaiting review'); }
			const files = this.selection(proposal, selected), patch = await this.patch(proposal, files);
			const baseline = await new GitSnapshotStore(proposal.workspace).capture();
			const conflicts = await this.conflicts(proposal, baseline, files);
			if (conflicts.length) { throw new Error(`Current edits conflict: ${conflicts.join(', ')}`); }
			const validationId = randomUUID(), directory = join(this.folder(id), 'validations', validationId);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const workspace = join(directory, 'workspace');
			await git(proposal.workspace, ['worktree', 'add', '--detach', workspace, baseline.commit]);
			await git(workspace, ['apply', '-'], patch);
			const candidate = await new GitSnapshotStore(workspace).capture();
			const evidence: ValidationEvidence = { id: validationId, proposalId: id, digest: expectedDigest, files, workspace, baseline, candidate, status: 'prepared', commands: [], startedAt: Date.now(), ownerPid: process.pid };
			proposal.validation = evidence; await this.save(proposal); return evidence;
		} finally { await release(); }
	}
	async recordValidation(evidence: ValidationEvidence): Promise<void> {
		const release = await claimOperation(this.folder(evidence.proposalId), 'proposal-operation-');
		try {
			const proposal = await this.load(evidence.proposalId);
			if (proposal.validation?.id !== evidence.id || proposal.digest !== evidence.digest) { throw new Error('Validation was superseded by another run'); }
			proposal.validation = evidence; await this.save(proposal);
		} finally { await release(); }
	}
	async sameTree(workspace: string, first: GitSnapshot, second: GitSnapshot): Promise<boolean> {
		return first.head === second.head && !(await git(workspace, ['diff-tree', '--no-commit-id', '--name-only', '-r', first.commit, second.commit])).trim();
	}
	async apply(id: string, expectedDigest: string, selected?: string[], validationId?: string): Promise<WorkspaceProposal> {
		const release = await claimOperation(this.folder(id), 'proposal-operation-');
		try { return await this.applyUnlocked(id, expectedDigest, selected, validationId); } finally { await release(); }
	}
	private async applyUnlocked(id: string, expectedDigest: string, selected?: string[], validationId?: string): Promise<WorkspaceProposal> {
		let proposal = await this.load(id);
		if (proposal.status !== 'review' || proposal.digest !== expectedDigest || !proposal.files.length) { throw new Error('No matching reviewed changes are available'); }
		const gitDir = (await git(proposal.workspace, ['rev-parse', '--absolute-git-dir'])).trim();
		const release = await claimOperation(gitDir, 'son-of-anton-apply-');
		const snapshots = new GitSnapshotStore(proposal.workspace);
		try {
			proposal = await this.load(id);
			if (proposal.status !== 'review' || proposal.digest !== expectedDigest) { throw new Error('Proposal is no longer awaiting review'); }
			if ((proposal.applications?.length ?? 0) >= 50) { throw new Error('This proposal has reached its 50-application retention limit'); }
			const files = this.selection(proposal, selected), patch = await this.patch(proposal, files);
			const recovery = await snapshots.capture();
			if (validationId) {
				const evidence = proposal.validation;
				if (!evidence || evidence.id !== validationId || evidence.status !== 'passed' || evidence.digest !== expectedDigest || JSON.stringify(evidence.files) !== JSON.stringify(files) || !await this.sameTree(proposal.workspace, evidence.baseline, recovery)) { await snapshots.release(recovery); throw new Error('Validation is stale or did not pass for these exact selected changes. Run validation again.'); }
			}
			const conflicts = await this.conflicts(proposal, recovery, files);
			if (conflicts.length) { await snapshots.release(recovery); throw new Error(`Current edits conflict with this proposal: ${conflicts.join(', ')}`); }
			try { await git(proposal.workspace, ['apply', '--check', '-'], patch); }
			catch (error) { await snapshots.release(recovery); throw error; }
			// Persist recovery before the first workspace write so a crash cannot lose it.
			proposal.recovery = recovery; proposal.status = 'applying'; proposal.ownerPid = process.pid; await this.save(proposal);
			try { await git(proposal.workspace, ['apply', '-'], patch); }
			catch (error) { proposal.status = 'interrupted'; proposal.error = `Application failed; recovery checkpoint retained: ${recovery.ref}`; await this.save(proposal); throw error; }
			proposal.appliedFiles = [...(proposal.appliedFiles ?? []), ...files];
			proposal.applications = [...(proposal.applications ?? []), { id: randomUUID(), files, recovery }];
			proposal.status = proposal.appliedFiles.length === proposal.files.length ? 'applied' : 'review'; await this.save(proposal);
			return proposal;
		} finally { await release(); }
	}
	/** Reverse the last selected application only; later unrelated edits remain untouched. */
	async restoreLastApplication(id: string): Promise<WorkspaceProposal> {
		const release = await claimOperation(this.folder(id), 'proposal-operation-');
		try {
			const proposal = await this.load(id), application = proposal.applications?.slice().reverse().find(item => !item.restored);
			if (!application || !proposal.result || !['review', 'applied'].includes(proposal.status)) { throw new Error('No completed application is available to restore'); }
			const gitDir = (await git(proposal.workspace, ['rev-parse', '--absolute-git-dir'])).trim();
			const releaseWorkspace = await claimOperation(gitDir, 'son-of-anton-apply-');
			try {
				const recovery = await new GitSnapshotStore(proposal.workspace).capture();
				if ((await this.conflicts(proposal, recovery, application.files, proposal.result.commit)).length) { throw new Error('Applied files have newer edits. Resolve those edits before restoring this application.'); }
				const patch = await this.patch(proposal, application.files, true);
				await git(proposal.workspace, ['apply', '--check', '-'], patch);
				proposal.recovery = recovery; proposal.status = 'applying'; proposal.ownerPid = process.pid; await this.save(proposal);
				try { await git(proposal.workspace, ['apply', '-'], patch); }
				catch (error) { proposal.status = 'interrupted'; proposal.error = `Restoration failed; recovery retained at ${recovery.ref}`; await this.save(proposal); throw error; }
				application.restored = true; proposal.appliedFiles = (proposal.appliedFiles ?? []).filter(file => !application.files.includes(file)); proposal.status = 'review'; await this.save(proposal); return proposal;
			} finally { await releaseWorkspace(); }
		} finally { await release(); }
	}
}
