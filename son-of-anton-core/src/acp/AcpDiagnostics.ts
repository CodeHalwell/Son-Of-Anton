/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { AcpConnection } from './AcpConnection';
import { object, type AcpAgentDefinition } from './protocol';
export interface AcpDiagnostic {
	id: string;
	status: 'unavailable' | 'failed' | 'session-ready' | 'prompt-completed' | 'cancelled';
	phase: 'launch' | 'initialize' | 'session' | 'prompt';
	authMethods: string[];
	modes: string[];
	textChunks: number;
	permissionsDenied: number;
	durationMs: number;
	error?: string;
	recovery?: string;
}
/** Bounded real protocol probe. Never grants tool permissions or records provider output/credentials. */
export async function diagnoseAcp(agent: AcpAgentDefinition, cwd: string, options: { live?: boolean; mode?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<AcpDiagnostic> {
	const started = Date.now();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error('ACP diagnostic timed out')), options.timeoutMs ?? (options.live ? 120_000 : 30_000));
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
	const result: AcpDiagnostic = { id: agent.id, status: 'failed', phase: 'launch', authMethods: [], modes: [], textChunks: 0, permissionsDenied: 0, durationMs: 0 };
	let connection: AcpConnection | undefined;
	try {
		signal.throwIfAborted(); connection = new AcpConnection(agent, cwd);
		result.phase = 'initialize'; const initialization = await connection.initialize(signal);
		result.authMethods = initialization.authMethods?.map(method => method.id) ?? [];
		result.phase = 'session'; await connection.newSession([], signal, options.mode); result.modes = connection.availableModes;
		result.status = 'session-ready';
		if (options.live) {
			result.phase = 'prompt';
			const reply = await connection.prompt('This is a connection diagnostic. Do not use tools, read files, run commands, or modify anything. Reply with exactly ACP_OK.', {
				signal, timeoutMs: options.timeoutMs ?? 120_000,
				update: update => { if (update.sessionUpdate === 'agent_message_chunk' && object(update.content) && typeof update.content.text === 'string' && update.content.text) { result.textChunks++; } },
				permission: async () => { result.permissionsDenied++; return { outcome: { outcome: 'cancelled' } }; },
			});
			if (reply.stopReason !== 'end_turn' || !result.textChunks) { throw new Error(`No completed text response (${reply.stopReason})`); }
			result.status = 'prompt-completed';
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		result.status = signal.aborted ? 'cancelled' : code === 'ENOENT' ? 'unavailable' : 'failed';
		let message = signal.aborted ? 'Diagnostic cancelled or timed out' : error instanceof Error ? error.message : 'ACP diagnostic failed';
		for (const value of Object.values(agent.env ?? {})) { if (value) { message = message.split(value).join('[redacted]'); } }
		// Spawn failures can echo the whole command line, including credential arguments.
		result.error = code === 'ENOENT' ? 'Adapter executable was not found. Configure an installed executable or a pinned registry adapter.' : message.replace(/(?:Bearer\s+|(?:api[_-]?key|token|password)[=:]\s*)[^\s,;]+/gi, '[redacted]').slice(0, 1000);
		if (result.phase === 'initialize' && /(?:^|[\s/])(?:gemini(?:-cli)?|@google\/gemini-cli)(?:@|[\s/]|$)/i.test([agent.id, agent.command, ...(agent.args ?? [])].join(' '))) {
			result.recovery = 'Gemini may be waiting for interactive Google sign-in before opening ACP. Run the configured Gemini CLI interactively without --acp, complete sign-in, close it, then retry this check. NO_BROWSER=true still requests a code on stdin and cannot authenticate over the ACP stream. Do not enter authorization codes into an ACP conversation.';
		}
	} finally { clearTimeout(timeout); await connection?.stop(); result.durationMs = Date.now() - started; }
	return result;
}
