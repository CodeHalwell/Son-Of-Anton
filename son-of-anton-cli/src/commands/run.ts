/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentHandle } from 'son-of-anton-core/dist/agents/types';
import type { ModelId } from 'son-of-anton-core/dist/llm/LlmClient';
import { buildCliAgentStack } from '../agentStackBuilder';
import { createApprovalGate, resolveApprovalMode } from '../approval';
import { bootstrapCredentials } from '../auth/bootstrap';
import { CliCancellation } from '../cancellation';
import { buildCliHost } from '../cliHost';
import {
	classifyError,
	mergeStdinIntoPrompt,
	readPipedStdin,
	SOTA_EXIT_CODES,
} from '../headless';
import { makeRenderer, type Renderer, type StreamEvent } from '../render/renderer';

interface RunOptions {
	model?: string;
	output: 'text' | 'json';
	quiet?: boolean;
	maxTurns?: string;
	/** `--yes` — auto-approve every write/command (headless use). */
	yes?: boolean;
	/** `--auto-approve` — alias for `--yes`. */
	autoApprove?: boolean;
}

/**
 * Strip a leading `@` from the supplied handle so users can invoke either
 * `sota run @anton-code "..."` (matches the chat surface convention) or
 * `sota run anton-code "..."` (saves a shell escape on most prompts).
 */
function normaliseHandle(raw: string): AgentHandle {
	const trimmed = raw.startsWith('@') ? raw.slice(1) : raw;
	return trimmed as AgentHandle;
}

/**
 * In `--quiet` mode we want the final assistant text on stdout (so
 * `$(sota run @anton-code "...")` works in shell scripts) and nothing else.
 * Tool annotations, errors, and progress markers go to stderr or are dropped
 * entirely depending on the output mode.
 */
function makeRunRenderer(opts: RunOptions): { renderer: Renderer; getCapturedText: () => string } {
	if (opts.quiet && opts.output === 'text') {
		let captured = '';
		const renderer: Renderer = {
			emit(event: StreamEvent): void {
				if (event.type === 'token') {
					captured += event.text;
					return;
				}
				if (event.type === 'error') {
					process.stderr.write(`error: ${event.message}\n`);
				}
				// Drop the rest in quiet mode — scripts only want the answer.
			},
			end(): void {
				// no-op; caller flushes captured text after success.
			},
		};
		return { renderer, getCapturedText: () => captured };
	}
	const renderer = makeRenderer(opts.output);
	return { renderer, getCapturedText: () => '' };
}

export async function runSpecialist(handle: string, prompt: string, opts: RunOptions): Promise<void> {
	const host = buildCliHost();

	const auth = await bootstrapCredentials(host);
	if (!auth.ok) {
		process.stderr.write(`error: ${auth.message}\n`);
		process.exit(SOTA_EXIT_CODES.HARD_FAIL);
	}

	// Merge piped stdin onto the prompt so users can do
	// `cat README.md | sota run @anton-docs "summarise"`.
	const piped = await readPipedStdin();
	const mergedPrompt = mergeStdinIntoPrompt(prompt, piped);

	const handleId = normaliseHandle(handle);
	const { renderer, getCapturedText } = makeRunRenderer(opts);

	// Resolve the tool-approval policy for this run. `--yes` / `--auto-approve`
	// approves every write/command up front (headless use); otherwise we prompt
	// y/N on a TTY and DENY by default when there is nothing to prompt on (piped
	// / non-interactive), so an unattended `sota run` can never silently mutate
	// the workspace. The gate is enforced inside the ToolExecutionContext (see
	// toolExecutionContext.ts), covering write_file / edit_file / run_command.
	const autoApprove = !!(opts.yes || opts.autoApprove);
	const approvalMode = resolveApprovalMode({ autoApprove, isTty: !!process.stdin.isTTY });
	const approvalGate = createApprovalGate(approvalMode);

	const built = buildCliAgentStack(host, { approvalGate });
	const specialist = built.stack.specialists.get(handleId);
	if (!specialist) {
		const known = [...built.stack.specialists.keys()].map(h => `@${h}`).join(', ');
		renderer.emit({
			type: 'error',
			message: `unknown specialist "@${handleId}". Available: ${known}`,
		});
		built.dispose();
		process.exit(SOTA_EXIT_CODES.HARD_FAIL);
	}

	const modelOverride: ModelId | undefined = opts.model ? (opts.model as ModelId) : undefined;

	const cancellation = new CliCancellation();
	const onSigint = (): void => cancellation.cancel();
	process.once('SIGINT', onSigint);

	try {
		// Drive the ACTUAL agentic path. `runAgenticTurn` runs the native
		// tool-use loop (read_file / write_file / edit_file / run_command /
		// search_workspace / glob) against the approval-gated
		// ToolExecutionContext, so `sota run @anton-code "fix the bug"`
		// genuinely edits files and runs commands instead of only streaming
		// prose. It falls back to a single-shot turn automatically when no
		// workspace tool context is available (e.g. no workspace root).
		const finalText = await specialist.runAgenticTurn(
			mergedPrompt,
			(event) => {
				if (event.type === 'token') {
					renderer.emit({ type: 'token', text: event.token });
					return;
				}
				// A tool call — surface start/end annotations so a watching user
				// (or a JSON consumer) can see which tools the agent invoked.
				if (event.status === 'running') {
					renderer.emit({ type: 'tool_call_start', name: event.name, input: event.input });
				} else {
					renderer.emit({
						type: 'tool_call_end',
						name: event.name,
						output: event.output,
						error: event.status === 'error' ? (event.output ?? 'tool failed') : undefined,
					});
				}
			},
			cancellation,
			modelOverride ? { modelOverride } : undefined,
		);
		renderer.emit({ type: 'done' });

		if (opts.quiet && opts.output === 'text') {
			// Quiet mode: emit only the final assistant text (the post-tool
			// summary) so `$(sota run @anton-code "...")` stays clean. Prefer the
			// loop's return value over captured tokens, which would also include
			// intermediate tool-planning turns.
			const finalOut = finalText.trim() || getCapturedText().trim();
			if (finalOut) {
				process.stdout.write(finalOut + '\n');
			}
		}
	} catch (err) {
		renderer.emit({
			type: 'error',
			message: err instanceof Error ? err.message : String(err),
		});
		process.exitCode = classifyError(err);
	} finally {
		process.off('SIGINT', onSigint);
		built.dispose();
	}

	// `--model` now maps to the loop's per-turn override above. `--max-turns`
	// stays advisory: the agentic loop uses a fixed internal iteration cap.
	// Routed to stderr so it never pollutes --output json.
	if (opts.output === 'text' && !opts.quiet && opts.maxTurns) {
		process.stderr.write(`note: --max-turns "${opts.maxTurns}" is advisory; the agent loop uses a fixed iteration cap.\n`);
	}
}
