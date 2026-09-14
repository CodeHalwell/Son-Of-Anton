/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

/**
 * Adapter for the OpenAI Codex CLI. Mirrors `claudeCodeRunner.ts`. When the
 * user has Codex CLI installed and signed in (with a ChatGPT Plus / Team /
 * Enterprise subscription), this lets Son of Anton route OpenAI traffic
 * through the CLI — same auth, same quota, no API key needed in settings.
 *
 * Codex CLI stores its OAuth credentials under `~/.codex/` similarly to
 * Claude Code's `~/.claude/`. We strip `OPENAI_API_KEY` from the spawned
 * process's environment so the CLI is forced to use its own subscription
 * tokens rather than falling through to a metered API key.
 *
 */

const STREAM_JSON_TIMEOUT_MS = 10 * 60 * 1000;

export interface CodexMessage {
	role: 'user' | 'assistant';
	content: string | Array<{ type: string;[key: string]: unknown }>;
}

export interface CodexRunOptions {
	readonly systemPrompt: string;
	readonly messages: ReadonlyArray<CodexMessage>;
	readonly modelId: string;
	readonly cwd?: string;
	readonly codexPath?: string;
	/**
	 * Optional cancellation signal. When it aborts, the spawned `codex`
	 * process is killed immediately (SIGTERM) instead of being left to run —
	 * and keep billing against the user's subscription — until the 10-minute
	 * stream timeout. Threaded through from `LlmRequestOptions.signal`.
	 */
	readonly signal?: AbortSignal;
}

export type CodexChunk =
	| { type: 'text'; text: string }
	| { type: 'system'; subtype: string; data?: unknown }
	| { type: 'usage'; inputTokens: number; outputTokens: number; cost?: number }
	| { type: 'error'; message: string }
	| { type: 'done' };

/**
 * Returns true if the `codex` CLI is on PATH. Cached after first call to
 * avoid a `spawn` per chat turn.
 */
let codexAvailableCache: boolean | undefined;
export function isCodexAvailable(): boolean {
	if (codexAvailableCache !== undefined) {
		return codexAvailableCache;
	}
	const candidates = process.env.PATH?.split(path.delimiter) ?? [];
	const exeNames = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
	for (const dir of candidates) {
		for (const name of exeNames) {
			try {
				const full = path.join(dir, name);
				fs.accessSync(full, fs.constants.X_OK);
				codexAvailableCache = true;
				return true;
			} catch {
				// not in this dir, keep looking
			}
		}
	}
	codexAvailableCache = false;
	return false;
}

/**
 * Reset the cache. Tests / explicit "I just installed Codex CLI" recovery.
 */
export function resetCodexAvailability(): void {
	codexAvailableCache = undefined;
}

/**
 * Stream Codex CLI output as a sequence of structured chunks. Yields `text`
 * events for completed assistant messages and `usage` / `error` /
 * `done` events for the lifecycle.
 *
 * Reports an error if Codex CLI is not installed — callers may check
 * {@link isCodexAvailable} first and route around to the API-key path.
 */
export async function* runCodex(options: CodexRunOptions): AsyncGenerator<CodexChunk> {
	if (options.signal?.aborted) { return; }
	if (!options.codexPath?.trim() && !isCodexAvailable()) {
		yield { type: 'error', message: 'OpenAI Codex CLI is not installed or not on PATH. Install it from https://github.com/openai/codex or add an OpenAI API key in settings.' };
		return;
	}

	// This is a text transport. Keep subscription auth, but exclude inherited
	// integrations and disable shell execution; workspace mutations use ACP.
	const args = [
		'exec', '--json', '--ephemeral', '--ignore-user-config',
		'--sandbox', 'read-only', '--skip-git-repo-check',
		'-c', 'features.shell_tool=false', '-c', 'web_search="disabled"',
		'-c', `developer_instructions=${JSON.stringify(options.systemPrompt)}`,
		...(options.modelId ? ['--model', options.modelId] : []), '-',
	];
	const prompt = 'Continue this conversation. Respond to the last user message. Do not use tools.\n'
		+ JSON.stringify(options.messages);
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.OPENAI_API_KEY;
	const proc = spawn(options.codexPath?.trim() || 'codex', args, { cwd: options.cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] });
	let spawnError: Error | undefined;
	// Register immediately: a short-lived or missing executable can close
	// before the stdout iterator finishes (including signal exits).
	const closed = new Promise<number | null>(resolve => {
		proc.once('error', error => { spawnError = error; });
		proc.once('close', resolve);
	});
	let stderr = '';
	proc.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-16384); });
	proc.stdin.on('error', () => { /* Early exit may close stdin before the prompt is written. */ });
	const stop = () => { if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGTERM'); } };
	const signal = options.signal;
	signal?.addEventListener('abort', stop, { once: true });
	let timedOut = false;
	const timeout = setTimeout(() => { timedOut = true; stop(); }, STREAM_JSON_TIMEOUT_MS);
	const rl = readline.createInterface({ input: proc.stdout });
	let completed = false;
	let failed = false;
	proc.stdin.end(prompt);
	try {
		for await (const line of rl) {
			if (signal?.aborted || timedOut) { break; }
			let event: CodexEvent;
			try { event = JSON.parse(line); } catch { continue; }
			if (!event || typeof event !== 'object') { continue; }
			if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
				yield { type: 'text', text: event.item.text };
			} else if (event.type === 'turn.completed') {
				completed = true;
				if (event.usage) { yield { type: 'usage', inputTokens: event.usage.input_tokens ?? 0, outputTokens: event.usage.output_tokens ?? 0 }; }
			} else if (!failed && (event.type === 'turn.failed' || event.type === 'error')) {
				failed = true;
				yield { type: 'error', message: event.error?.message || event.message || 'Codex CLI request failed.' };
			}
		}
		const exitCode = await closed;
		if (signal?.aborted) { return; }
		if (timedOut) { yield { type: 'error', message: 'Codex CLI request timed out.' }; }
		else if (spawnError) { yield { type: 'error', message: `Unable to start Codex CLI: ${spawnError.message}` }; }
		else if (!failed && exitCode !== 0) { yield { type: 'error', message: `Codex CLI exited ${exitCode ?? proc.signalCode}: ${stderr.trim() || '(no stderr)'}` }; }
		else if (!failed && !completed) { yield { type: 'error', message: 'Codex CLI exited without completing a response.' }; }
		else if (!failed) { yield { type: 'done' }; }
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener('abort', stop);
		rl.close();
		stop();
		proc.stdout.destroy();
	}
}

interface CodexEvent {
	type?: string;
	item?: { type?: string; text?: string };
	usage?: { input_tokens?: number; output_tokens?: number };
	error?: { message?: string };
	message?: string;
}

/**
 * Surface "is the user signed in?" state. Like Claude Code, the static
 * "is installed" check happens here; the runtime "is signed in" check
 * happens implicitly by attempting a streamed call and observing whether
 * it errors before producing tokens.
 */
export function describeCodexAvailability(): { installed: boolean; hint?: string } {
	if (!isCodexAvailable()) {
		return {
			installed: false,
			hint: 'Install the OpenAI Codex CLI from https://github.com/openai/codex to sign in with your ChatGPT Plus/Team/Enterprise subscription.',
		};
	}
	return { installed: true };
}
