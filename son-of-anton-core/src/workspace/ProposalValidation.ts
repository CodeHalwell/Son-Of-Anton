/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import spawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { GitSnapshotStore, type GitSnapshot } from '../checkpoint/GitSnapshotStore';
import type { IsolatedWorkspace } from './IsolatedWorkspace';

export interface ValidationCommand { script: string; body: string; manifestDigest: string }
export interface ValidationEvidence {
	id: string; proposalId: string; digest: string; files: string[]; workspace: string;
	baseline: GitSnapshot; candidate: GitSnapshot; ownerPid: number;
	status: 'prepared' | 'running' | 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'stale' | 'interrupted';
	commands: (ValidationCommand & { exitCode: number | null; durationMs: number; log: string })[];
	startedAt: number; finishedAt?: number; error?: string;
}
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function manifestDigest(workspace: string, manifest: Buffer): Promise<string> {
	let lock = Buffer.alloc(0); try { lock = await readFile(join(workspace, 'package-lock.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	return hash(Buffer.concat([manifest, Buffer.from('\0'), lock]));
}
export function validationCommandLabel(command: ValidationCommand): string { return command.script === '@dependencies' ? 'npm ci --ignore-scripts --no-audit --no-fund' : `npm run ${command.script} --ignore-scripts`; }

/** Discover commands for explicit review. No script runs during discovery. */
export async function validationCommands(workspace: string): Promise<ValidationCommand[]> {
	let manifest: Buffer;
	try { manifest = await readFile(join(workspace, 'package.json')); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
	if (manifest.length > 1024 * 1024) { throw new Error('Package manifest exceeds the review limit'); }
	const parsed = JSON.parse(manifest.toString()) as { scripts?: Record<string, string> };
	const digest = await manifestDigest(workspace, manifest);
	const commands = ['typecheck', 'check', 'build', 'lint', 'test'].filter(script => typeof parsed.scripts?.[script] === 'string').map(script => ({ script, body: parsed.scripts![script], manifestDigest: digest }));
	try { await readFile(join(workspace, 'package-lock.json')); commands.unshift({ script: '@dependencies', body: 'Install the locked dependencies into this validation workspace. Package lifecycle hooks are disabled.', manifestDigest: digest }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
	return commands;
}

/** Execute only approved package scripts in the retained validation candidate, with bounded logs. */
export async function runProposalValidation(store: IsolatedWorkspace, evidence: ValidationEvidence, commands: ValidationCommand[], signal?: AbortSignal, timeoutMs = 300_000): Promise<ValidationEvidence> {
	if (!commands.length || commands.length > 8 || new Set(commands.map(command => command.script)).size !== commands.length) { throw new Error('Select between one and eight distinct validation commands'); }
	if (evidence.status !== 'prepared') { throw new Error('Prepare a fresh validation candidate before running commands'); }
	const approved = await validationCommands(evidence.workspace);
	if (commands.some(command => !approved.some(item => JSON.stringify(item) === JSON.stringify(command)))) { throw new Error('Validation commands changed after approval'); }
	// Check the exact candidate again: changes made while its approval was open invalidate the run.
	const snapshots = new GitSnapshotStore(evidence.workspace), current = await snapshots.capture();
	const unchanged = await store.sameTree(evidence.workspace, evidence.candidate, current); await snapshots.release(current);
	if (!unchanged) { throw new Error('Validation candidate changed after review'); }
	evidence.status = 'running'; evidence.ownerPid = process.pid; await store.recordValidation(evidence);
	try {
		for (const command of commands) {
			if (signal?.aborted) { evidence.status = 'cancelled'; break; }
			if (await manifestDigest(evidence.workspace, await readFile(join(evidence.workspace, 'package.json'))) !== command.manifestDigest) { evidence.status = 'stale'; evidence.error = 'Package scripts or dependency lock changed during validation'; break; }
			const result = await runCommand(evidence.workspace, command, signal, timeoutMs);
			const log = join(dirname(evidence.workspace), `command-${evidence.commands.length + 1}.log`);
			await writeFile(log, result.output, { flag: 'wx', mode: 0o600 });
			evidence.commands.push({ ...command, exitCode: result.exitCode, durationMs: result.durationMs, log });
			if (result.status !== 'passed') { evidence.status = result.status; break; }
			await store.recordValidation(evidence);
		}
		if (evidence.status === 'running') {
			const after = await snapshots.capture();
			evidence.status = await store.sameTree(evidence.workspace, evidence.candidate, after) ? 'passed' : 'stale'; await snapshots.release(after);
			if (evidence.status === 'stale') { evidence.error = 'Validation commands changed source files. Review and rerun against the resulting changes.'; }
		}
	} catch (error) { evidence.status = signal?.aborted ? 'cancelled' : 'failed'; evidence.error = error instanceof Error ? error.message : String(error); }
	evidence.finishedAt = Date.now(); await store.recordValidation(evidence); return evidence;
}

function runCommand(workspace: string, command: ValidationCommand, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ status: 'passed' | 'failed' | 'cancelled' | 'timed-out'; exitCode: number | null; output: string; durationMs: number }> {
	return new Promise(resolve => {
		const started = Date.now(); let output = '', truncated = false, status: 'cancelled' | 'timed-out' | undefined, finished = false, killTimer: NodeJS.Timeout | undefined;
		const args = command.script === '@dependencies' ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund'] : ['run', command.script, '--ignore-scripts'];
		const child = spawn('npm', args, { cwd: workspace, stdio: 'pipe', detached: process.platform !== 'win32', env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), CI: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false' } });
		const append = (chunk: Buffer | string) => { output += chunk.toString(); if (output.length > 256 * 1024) { output = output.slice(-256 * 1024); truncated = true; } };
		child.stdout?.on('data', append); child.stderr?.on('data', append); child.stdin?.end();
		const terminate = () => {
			if (!child.pid) { return; }
			if (process.platform === 'win32') { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, () => child.kill()); }
			else {
				try { process.kill(-child.pid, 'SIGTERM'); } catch { }
				killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { } }, 1000);
			}
		};
		const abort = () => { status = 'cancelled'; terminate(); };
		const timer = setTimeout(() => { status = 'timed-out'; terminate(); }, Math.max(1, Math.min(timeoutMs, 30 * 60_000)));
		const finish = (code: number | null) => {
			if (finished) { return; } finished = true; clearTimeout(timer); if (killTimer) { clearTimeout(killTimer); }
			// A script may exit while descendants continue. Reap our POSIX process group as well.
			if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { } }
			signal?.removeEventListener('abort', abort);
			resolve({ status: status ?? (code === 0 ? 'passed' : 'failed'), exitCode: code, output: (truncated ? '[Earlier output truncated]\n' : '') + output, durationMs: Date.now() - started });
		};
		child.on('error', error => { append(error.message); finish(null); }); child.on('close', finish);
		signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); }
	});
}
