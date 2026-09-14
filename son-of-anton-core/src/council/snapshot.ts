/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { CouncilSnapshot } from './types';

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => execFile('git', ['--no-pager', ...args], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
/** Capture tracked changes without changing HEAD, the index, refs, or stash. */
export async function captureCouncilSnapshot(workspace: string, revision = 'HEAD'): Promise<CouncilSnapshot> {
	const root = await realpath(workspace);
	if (await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim()) !== root) { throw new Error('Open the Git worktree root to review changes.'); }
	if (!revision || revision.length > 256 || revision.startsWith('-') || /[\s\0]/.test(revision)) { throw new Error('Enter a Git revision such as HEAD or HEAD~1.'); }
	const base = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).trim();
	const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
	const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', base, '--'];
	const patch = await git(root, args);
	if (!patch.trim()) { throw new Error('No tracked changes against this revision. Choose an earlier revision or edit a tracked file.'); }
	if (Buffer.byteLength(patch) > 256 * 1024) { throw new Error('The review diff exceeds 256 KiB. Review a smaller change before starting Council.'); }
	const files = (await git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, '--'])).split('\0').filter(Boolean);
	if (patch !== await git(root, args) || head !== (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()) { throw new Error('Repository changed while capturing the diff. Retry the review.'); }
	return { workspace: root, base, head, patch, files, digest: createHash('sha256').update(patch).digest('hex'), capturedAt: Date.now(), limitations: ['Tracked diff only; untracked and ignored files are excluded', 'No tests or tools are executed', 'Binary contents and unchanged file context are not included'] };
}
