/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { CoreHost } from 'son-of-anton-core/dist/host';
import type { ToolExecutionContext } from 'son-of-anton-core/dist/tools/types';
import type { ApprovalGate } from './approval';

const SEARCH_FILE_BYTE_CAP = 256 * 1024;
const RUN_COMMAND_OUTPUT_CAP = 256 * 1024;
const SEARCH_DEFAULT_IGNORES: ReadonlyArray<string> = [
	'node_modules', '.git', 'dist', 'out', 'build', '.next', '.turbo', '.cache',
	'__pycache__', '.venv', 'venv', 'target',
];

/**
 * Build a `ToolExecutionContext` for the CLI host backed by Node's
 * `fs/promises` and `child_process.spawn`.
 *
 * Approval: when an `approvalGate` is supplied, the two side-effecting
 * operations — `writeFile` (backing the `write_file` / `edit_file` tools) and
 * `runCommand` (backing `run_command`) — are gated through it *before* they
 * touch disk or spawn a process. These are exactly the tools the core marks
 * `riskLevel: 'requiresApproval'`. A denied request is surfaced back to the
 * model as a non-fatal `{ written: false }` / `{ ran: false }` result (with
 * the gate's reason), so the tool loop can adapt rather than crash. Read-only
 * operations (`readFile`, `readDir`, `searchTextInWorkspace`) are never gated.
 * Callers that omit the gate keep the prior behaviour — every call runs
 * immediately.
 *
 * Path safety: every method validates that the supplied workspace-relative
 * path stays inside `workspaceRoot`. `..` segments and absolute paths are
 * rejected at the boundary so the model can't escape the workspace via a
 * crafted argument.
 *
 * When a `host` is supplied, the returned context exposes a `getConfigValue`
 * accessor wired to the host's config store so tools (e.g. `run_command`'s
 * sandbox-mode check) can read settings at execute time. Callers without a
 * host see the safest defaults — the `run_command` sandbox stays in `'safe'`.
 */
export function buildCliToolExecutionContext(workspaceRoot: string, host?: CoreHost, approvalGate?: ApprovalGate): ToolExecutionContext {
	const root = path.resolve(workspaceRoot);

	const resolveRelative = (relPath: string): string => {
		if (relPath.includes('\0') || relPath.startsWith('/') || relPath.startsWith('\\')) {
			throw new Error(`Path rejected: must be a workspace-relative path without traversal — got "${relPath}".`);
		}
		const abs = path.resolve(root, relPath);
		if (abs !== root && !abs.startsWith(root + path.sep)) {
			throw new Error(`Path rejected: "${relPath}" resolves outside the workspace.`);
		}
		return abs;
	};

	return {
		workspaceRoot: root,

		getConfigValue: <T>(key: string): T | undefined => {
			return host?.config.get<T>(key);
		},

		readFile: async (relPath) => {
			const abs = resolveRelative(relPath);
			return await fs.readFile(abs, 'utf-8');
		},

		readDir: async (relPath) => {
			const abs = relPath ? resolveRelative(relPath) : root;
			const entries = await fs.readdir(abs, { withFileTypes: true });
			return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
		},

		searchTextInWorkspace: async (query, maxMatches) => {
			const matches: Array<{ relPath: string; line: number; preview: string }> = [];
			const cap = Math.max(1, Math.min(maxMatches, 200));
			await walkAndSearch(root, '', query, cap, matches);
			return matches;
		},

		writeFile: async (relPath, content) => {
			const abs = resolveRelative(relPath);
			if (approvalGate) {
				const decision = await approvalGate({ kind: 'write', detail: relPath });
				if (!decision.approved) {
					return { written: false, reason: decision.reason ?? 'declined by user' };
				}
			}
			let preImage: string | undefined;
			let existed = false;
			try {
				preImage = await fs.readFile(abs, 'utf-8');
				existed = true;
			} catch {
				// File doesn't exist yet — that's fine for a write.
			}
			await fs.mkdir(path.dirname(abs), { recursive: true });
			await fs.writeFile(abs, content);
			return { written: true, preImage, existed };
		},

		runCommand: async (command, args, opts) => {
			const cwd = opts?.cwd ? resolveRelative(opts.cwd) : root;
			if (approvalGate) {
				const detail = [command, ...args].join(' ');
				const decision = await approvalGate({ kind: 'command', detail });
				if (!decision.approved) {
					return { ran: false, reason: decision.reason ?? 'declined by user' };
				}
			}
			const timeoutMs = Math.max(100, Math.min(opts?.timeoutMs ?? 30_000, 120_000));
			return await new Promise(resolve => {
				const child = spawn(command, [...args], {
					cwd,
					shell: false,
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				let stdout = '';
				let stderr = '';
				let timedOut = false;
				let settled = false;

				const timer = setTimeout(() => {
					timedOut = true;
					try { child.kill('SIGKILL'); } catch { /* already dead */ }
				}, timeoutMs);

				child.stdout?.on('data', (chunk: Buffer) => {
					if (stdout.length < RUN_COMMAND_OUTPUT_CAP) {
						stdout += chunk.toString('utf-8');
					}
				});
				child.stderr?.on('data', (chunk: Buffer) => {
					if (stderr.length < RUN_COMMAND_OUTPUT_CAP) {
						stderr += chunk.toString('utf-8');
					}
				});

				const finish = (exitCode: number | undefined): void => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(timer);
					resolve({
						ran: true,
						stdout: stdout.slice(0, RUN_COMMAND_OUTPUT_CAP),
						stderr: stderr.slice(0, RUN_COMMAND_OUTPUT_CAP),
						exitCode,
						timedOut,
					});
				};

				child.on('close', (code) => finish(code === null ? undefined : code));
				child.on('error', (err) => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(timer);
					resolve({ ran: false, reason: err.message });
				});
			});
		},
	};
}

async function walkAndSearch(
	rootAbs: string,
	relDir: string,
	query: string,
	cap: number,
	matches: Array<{ relPath: string; line: number; preview: string }>,
): Promise<void> {
	if (matches.length >= cap) {
		return;
	}
	const dirAbs = relDir ? path.join(rootAbs, relDir) : rootAbs;
	let entries: { name: string; isDirectory: () => boolean }[];
	try {
		const dirents = await fs.readdir(dirAbs, { withFileTypes: true });
		entries = dirents.map(d => ({ name: d.name, isDirectory: () => d.isDirectory() }));
	} catch {
		return;
	}
	for (const entry of entries) {
		if (matches.length >= cap) {
			return;
		}
		if (SEARCH_DEFAULT_IGNORES.includes(entry.name)) {
			continue;
		}
		const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			await walkAndSearch(rootAbs, childRel, query, cap, matches);
			continue;
		}
		const childAbs = path.join(rootAbs, childRel);
		try {
			const stat = await fs.stat(childAbs);
			if (stat.size > SEARCH_FILE_BYTE_CAP) {
				continue;
			}
			const text = await fs.readFile(childAbs, 'utf-8');
			const lines = text.split('\n');
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].includes(query)) {
					matches.push({ relPath: childRel, line: i + 1, preview: lines[i].slice(0, 200) });
					if (matches.length >= cap) {
						return;
					}
				}
			}
		} catch {
			// Skip unreadable files — likely binary or permission-denied.
		}
	}
}
