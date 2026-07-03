/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as readline from 'node:readline';

/**
 * Per-call tool-approval for `sota run`. Tools whose `riskLevel` is
 * `'requiresApproval'` (writes and shell commands) are gated behind this
 * layer before they touch the workspace. The gate is consulted at the
 * `ToolExecutionContext` boundary (see `toolExecutionContext.ts`) so both the
 * `write_file`/`edit_file` tools (via `writeFile`) and `run_command` (via
 * `runCommand`) are covered by one policy.
 *
 * The pure decision logic (`resolveApprovalMode`, `interpretApprovalAnswer`,
 * `decideApproval`) is kept separate from the readline I/O so it can be unit
 * tested without a TTY.
 */

/**
 * How approvals are resolved for a run:
 *
 *  - `'auto'`        — approve every request without prompting. Selected by
 *                      `--yes` / `--auto-approve`; the escape hatch for
 *                      headless / scripted invocations.
 *  - `'interactive'` — prompt the user y/N on the TTY before each request.
 *  - `'deny'`        — refuse every request. Selected when there is no TTY to
 *                      prompt on and `--yes` was not passed, so an
 *                      unattended pipe can never silently mutate the
 *                      workspace.
 */
export type ApprovalMode = 'auto' | 'interactive' | 'deny';

/** A single request for permission to perform a side-effecting tool call. */
export interface ApprovalRequest {
	/** `'write'` for file mutations, `'command'` for shell execution. */
	readonly kind: 'write' | 'command';
	/** Human-readable subject: the file path, or the full command line. */
	readonly detail: string;
}

/** The outcome of consulting the gate for one request. */
export interface ApprovalDecision {
	readonly approved: boolean;
	/**
	 * Short, model-facing explanation surfaced through the tool result when
	 * the request was not approved. Undefined when approved.
	 */
	readonly reason?: string;
}

/** Async gate the tool-execution context awaits before each risky call. */
export type ApprovalGate = (request: ApprovalRequest) => Promise<ApprovalDecision>;

/** Reason surfaced when a non-interactive run refuses a risky call. */
const DENY_REASON = 'denied: non-interactive session (re-run with --yes / --auto-approve to allow)';

/** Reason surfaced when the user answers "no" at the prompt. */
const DECLINED_REASON = 'declined by user';

/**
 * Resolve the approval mode from the run's flags and the environment. Pure so
 * it can be unit tested:
 *
 *  - `--yes` always wins → `'auto'`.
 *  - otherwise a TTY → `'interactive'`.
 *  - otherwise (piped / non-interactive, no `--yes`) → `'deny'`.
 */
export function resolveApprovalMode(opts: { autoApprove: boolean; isTty: boolean }): ApprovalMode {
	if (opts.autoApprove) {
		return 'auto';
	}
	return opts.isTty ? 'interactive' : 'deny';
}

/**
 * Interpret a typed approval answer. Only an explicit affirmative
 * (`y` / `yes`, case-insensitive, surrounding whitespace ignored) approves;
 * everything else — including the empty string from a bare Enter — denies, so
 * the safe default is "no".
 */
export function interpretApprovalAnswer(answer: string): boolean {
	const normalised = answer.trim().toLowerCase();
	return normalised === 'y' || normalised === 'yes';
}

/**
 * Pure approval decision. For `'interactive'` mode the caller supplies the
 * user's typed `answer`; for `'auto'` / `'deny'` the answer is ignored.
 */
export function decideApproval(mode: ApprovalMode, answer?: string): ApprovalDecision {
	if (mode === 'auto') {
		return { approved: true };
	}
	if (mode === 'deny') {
		return { approved: false, reason: DENY_REASON };
	}
	return interpretApprovalAnswer(answer ?? '')
		? { approved: true }
		: { approved: false, reason: DECLINED_REASON };
}

/**
 * Compose the one-line prompt shown before an interactive approval. Kept pure
 * (and exported) so its wording is covered by tests.
 */
export function formatApprovalPrompt(request: ApprovalRequest): string {
	const label = request.kind === 'write' ? 'Allow write to' : 'Allow command';
	const separator = request.kind === 'write' ? ' ' : ': ';
	return `sota: ${label}${separator}${request.detail}? [y/N] `;
}

/**
 * Build the {@link ApprovalGate} for a run.
 *
 * `'auto'` and `'deny'` never touch stdin/stdout. `'interactive'` prompts on
 * stderr (so stdout stays clean for `--quiet` / `--output json`) and reads a
 * single line from stdin per request. The prompt is skipped and the request
 * denied if stdin has closed mid-run.
 */
export function createApprovalGate(mode: ApprovalMode): ApprovalGate {
	if (mode !== 'interactive') {
		// No I/O needed — resolve synchronously from the pure decision.
		const decision = decideApproval(mode);
		return async () => decision;
	}
	return async (request: ApprovalRequest): Promise<ApprovalDecision> => {
		const answer = await promptOnce(formatApprovalPrompt(request));
		return decideApproval('interactive', answer);
	};
}

/**
 * Ask a single y/N question on the user's terminal. Prompt text goes to
 * stderr; the answer is read from stdin. Resolves to an empty string (→ deny)
 * if stdin is not readable.
 */
function promptOnce(prompt: string): Promise<string> {
	return new Promise<string>(resolve => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
		rl.question(prompt, answer => {
			rl.close();
			resolve(answer);
		});
	});
}
