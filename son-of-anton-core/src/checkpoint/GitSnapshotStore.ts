/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';

/** A retained snapshot. Working-tree and staged trees are deliberately separate. */
export interface GitSnapshot {
	readonly version: 1;
	readonly workspaceRoot: string;
	readonly gitDir: string;
	readonly head: string;
	readonly commit: string;
	readonly indexTree: string;
	readonly ref: string;
}

const REF_PREFIX = 'refs/son-of-anton/checkpoints/';
const SHA = /^[a-f0-9]{40,64}$/;

function git(cwd: string, args: readonly string[], indexFile?: string): Promise<string> {
	// A host launched from another Git operation must not redirect this worktree.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
	return new Promise((resolve, reject) => {
		execFile('git', ['--literal-pathspecs', ...args], {
			cwd, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
			env: { ...env, GIT_TERMINAL_PROMPT: '0', ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}) },
		}, (error, stdout) => error ? reject(error) : resolve(stdout));
	});
}

/** Snapshot operations never move HEAD or modify the user's stash list. */
export class GitSnapshotStore {
	constructor(private readonly workspace: string) { }

	private async identity(): Promise<{ workspaceRoot: string; gitDir: string; head: string }> {
		const workspaceRoot = await fs.realpath(this.workspace);
		const top = await fs.realpath((await git(workspaceRoot, ['rev-parse', '--show-toplevel'])).trim());
		if (top !== workspaceRoot) {
			throw new Error('Open the Git worktree root to capture or restore a checkpoint.');
		}
		const gitDir = await fs.realpath((await git(workspaceRoot, ['rev-parse', '--absolute-git-dir'])).trim());
		const head = (await git(workspaceRoot, ['rev-parse', '--verify', 'HEAD'])).trim();
		return { workspaceRoot, gitDir, head };
	}

	private async locked<T>(operation: () => Promise<T>): Promise<T> {
		const { gitDir } = await this.identity();
		const lockPath = path.join(gitDir, 'son-of-anton-checkpoint.lock');
		const lock = await fs.open(lockPath, 'wx', 0o600).catch(() => {
			throw new Error('Another checkpoint operation is in progress. Retry after it finishes.');
		});
		try {
			return await operation();
		} finally {
			await lock.close();
			await fs.unlink(lockPath);
		}
	}

	async capture(): Promise<GitSnapshot> {
		return this.locked(() => this.captureUnlocked());
	}

	private async captureUnlocked(): Promise<GitSnapshot> {
		const identity = await this.identity();
		const root = identity.workspaceRoot;
		const entries = (await git(root, ['ls-files', '--stage', '-z'])).split('\0');
		if (entries.some(entry => entry.startsWith('160000 '))) {
			throw new Error('Checkpoints do not include submodule working trees. Open the submodule separately.');
		}
		const indexTree = (await git(root, ['write-tree'])).trim();
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sota-snapshot-'));
		try {
			const indexFile = path.join(temporary, 'index');
			await git(root, ['read-tree', indexTree], indexFile);
			// Capture non-ignored untracked files as well as tracked files, without
			// changing the real index. Ignored files are intentionally excluded.
			await git(root, ['add', '--all', '--', '.'], indexFile);
			const tree = (await git(root, ['write-tree'], indexFile)).trim();
			const commitArgs = ['-c', 'user.name=Son of Anton', '-c', 'user.email=checkpoints@son-of-anton.invalid', '-c', 'commit.gpgsign=false', 'commit-tree'];
			const staged = (await git(root, [...commitArgs, indexTree, '-p', identity.head, '-m', 'Checkpoint staging area'])).trim();
			const commit = (await git(root, [...commitArgs, tree, '-p', staged, '-p', identity.head, '-m', 'Checkpoint working tree'])).trim();
			const ref = `${REF_PREFIX}${randomUUID()}`;
			await git(root, ['update-ref', ref, commit]);
			return { version: 1, ...identity, commit, indexTree, ref };
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}

	async validate(snapshot: GitSnapshot): Promise<void> {
		const identity = await this.identity();
		if (snapshot.version !== 1 || identity.workspaceRoot !== snapshot.workspaceRoot || identity.gitDir !== snapshot.gitDir) {
			throw new Error('This checkpoint belongs to a different Git worktree.');
		}
		if (identity.head !== snapshot.head) {
			throw new Error('HEAD changed since this checkpoint. Return to the captured commit before restoring.');
		}
		if (!SHA.test(snapshot.commit) || !SHA.test(snapshot.indexTree) || !/^refs\/son-of-anton\/checkpoints\/[a-f0-9-]+$/.test(snapshot.ref)) {
			throw new Error('Invalid checkpoint snapshot.');
		}
		if ((await git(identity.workspaceRoot, ['rev-parse', '--verify', snapshot.ref])).trim() !== snapshot.commit) {
			throw new Error('The retained checkpoint is no longer available.');
		}
		if ((await git(identity.workspaceRoot, ['rev-parse', `${snapshot.commit}^1^{tree}`])).trim() !== snapshot.indexTree) {
			throw new Error('Checkpoint staging area does not match the retained snapshot.');
		}
	}

	/** Preview, retain a recovery point, and restore with a rollback on failure. */
	async restore(snapshot: GitSnapshot, confirm: (files: readonly string[]) => Promise<boolean>): Promise<GitSnapshot | undefined> {
		return this.locked(async () => {
			await this.validate(snapshot);
			const recovery = await this.captureUnlocked();
			let confirmed = false;
			let mutationStarted = false;
			try {
				const files = (await git(snapshot.workspaceRoot, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', recovery.commit, snapshot.commit])).split('\0').filter(Boolean);
				confirmed = await confirm(files);
				if (!confirmed) {
					return undefined;
				}
				// The confirmation may have been open while a user edited files. Take
				// a fresh recovery snapshot rather than overwrite those edits unseen.
				const current = await this.captureUnlocked();
				const changed = (await git(snapshot.workspaceRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', current.commit, recovery.commit])).trim();
				if (changed || current.indexTree !== recovery.indexTree) {
					await this.release(current);
					throw new Error('Files changed while confirming. Review the checkpoint again before restoring.');
				}
				await this.release(current);
				await this.validate(snapshot);
				await this.protectIgnoredFiles(snapshot, recovery);
				try {
					mutationStarted = true;
					await this.apply(snapshot, recovery);
				} catch (error) {
					try {
						await this.apply(recovery, snapshot);
					} catch {
						throw new Error(`Restore and rollback failed. Recovery is retained at ${recovery.ref}.`, { cause: error });
					}
					throw new Error(`Restore failed; the previous workspace was recovered (${recovery.ref}).`, { cause: error });
				}
				return recovery;
			} finally {
				if (!mutationStarted) {
					await this.release(recovery);
				}
			}
		});
	}

	private async protectIgnoredFiles(target: GitSnapshot, current: GitSnapshot): Promise<void> {
		const paths = (await git(target.workspaceRoot, ['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', current.commit, target.commit])).split('\0').filter(Boolean);
		const ignored = (await git(target.workspaceRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
		if (ignored.some(file => paths.some(changed => file === changed || file.startsWith(`${changed}/`) || changed.startsWith(`${file}/`)))) {
			throw new Error('Restore would overwrite an ignored file. Move that file out of the affected path first.');
		}
	}

	private async apply(target: GitSnapshot, current: GitSnapshot): Promise<void> {
		const root = target.workspaceRoot;
		// Include files created after capture in the temporary tracked set so
		// Git removes them on restore. HEAD and refs/stash stay untouched.
		await git(root, ['read-tree', `${current.commit}^{tree}`]);
		await git(root, ['read-tree', '--reset', '-u', `${target.commit}^{tree}`]);
		await git(root, ['read-tree', target.indexTree]);
	}

	async release(snapshot: GitSnapshot): Promise<void> {
		if (/^refs\/son-of-anton\/checkpoints\/[a-f0-9-]+$/.test(snapshot.ref) && SHA.test(snapshot.commit)) {
			await git(snapshot.workspaceRoot, ['update-ref', '-d', snapshot.ref, snapshot.commit]);
		}
	}
}
