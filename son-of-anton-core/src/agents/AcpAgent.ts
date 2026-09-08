/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AcpRuntime } from '../acp/AcpRuntime';
import { object, type AcpAgentDefinition, type AcpPermissionHandler } from '../acp/protocol';
import type { CancellationLike, ChatContextLike, ChatRequestLike, ChatStreamLike } from '../chatStream';
import { BaseAgent, type AgentContext, type ChatTurnOptions } from './BaseAgent';
import type { FileChange, SubtaskResult } from './types';
interface AcpTurnOptions extends ChatTurnOptions { onReportedChange?: (change: FileChange) => void }

/** A specialist backed by a real ACP agent, sharing the host's process budget and approval surface. */
export class AcpAgent extends BaseAgent {
	private readonly history = new Map<string, string[]>();
	constructor(
		private readonly runtime: AcpRuntime,
		private readonly definition: AcpAgentDefinition,
		private readonly cwd: string,
		private readonly instructions: () => string,
		private readonly permission: AcpPermissionHandler | undefined,
		private readonly interpret: (result: SubtaskResult) => SubtaskResult,
		...base: ConstructorParameters<typeof BaseAgent>
	) { super(...base); }

	protected getRoleDescription(): string { return this.instructions(); }

	override async execute(context: AgentContext): Promise<SubtaskResult> {
		const controller = new AbortController();
		const signal = context.signal ?? controller.signal;
		const cancellation: CancellationLike = {
			get isCancellationRequested() { return signal.aborted; },
			onCancellationRequested: listener => { signal.addEventListener('abort', listener); return { dispose: () => signal.removeEventListener('abort', listener) }; },
		};
		try {
			const changes = new Map<string, FileChange>();
			const summary = await this.runAgenticTurn(`${context.instruction}\n\nScope files: ${context.scopeFiles.join(', ')}\n${context.graphContext}`, event => { if (event.type === 'token') { context.onToken?.(event.token); } }, cancellation, { conversationId: `${context.parentTaskId}:${this.handle}`, onReportedChange: change => changes.set(change.filePath, change) });
			return this.interpret({ success: true, changes: [...changes.values()], summary, tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0, accounting: 'unavailable' } });
		} catch (error) {
			return { success: false, changes: [], summary: error instanceof Error ? error.message : 'ACP agent failed', tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0, accounting: 'unavailable' } };
		}
	}

	override async handleChatRequest(request: ChatRequestLike, _context: ChatContextLike, stream: ChatStreamLike, cancellation: CancellationLike): Promise<void> {
		await this.runChatTurn(request.command ? `/${request.command} ${request.prompt}` : request.prompt, text => stream.markdown(text), cancellation, { conversationId: request.conversationId, workspaceContextSnapshot: request.workspaceContextSnapshot });
	}

	override async runChatTurn(text: string, emit: (token: string) => void, cancellation: CancellationLike, options?: ChatTurnOptions): Promise<string> {
		return this.runAgenticTurn(text, event => { if (event.type === 'token') { emit(event.token); } }, cancellation, options);
	}

	override async runAgenticTurn(text: string, emit: Parameters<BaseAgent['runAgenticTurn']>[1], cancellation: CancellationLike, options?: AcpTurnOptions): Promise<string> {
		this.spendGuard?.assertWithinBudget();
		const controller = new AbortController();
		const subscription = cancellation.onCancellationRequested(() => controller.abort());
		if (cancellation.isCancellationRequested) { controller.abort(); }
		const task = this.agentManager.createTask(this.displayName, text.slice(0, 100));
		this.agentManager.startTask(task.id);
		let response = '';
		const conversationId = `${this.handle}:${options?.conversationId ?? randomUUID()}`;
		const tools = new Map<string, { name: string; input: Record<string, unknown>; kind?: string; locations?: unknown }>();
		try {
			const result = await this.runtime.run({
				agent: this.definition, cwd: this.cwd,
				conversationId,
				initialContext: [this.instructions(), ...(this.history.get(conversationId) ?? [])].join('\n\n'),
				text: options?.workspaceContextSnapshot ? `${text}\n\nWorkspace context:\n${options.workspaceContextSnapshot}` : text,
				signal: controller.signal, timeoutMs: this.config.perTurnTimeoutMs,
				onPermission: this.permission,
				onUpdate: update => {
					if (update.sessionUpdate === 'agent_message_chunk' && object(update.content) && typeof update.content.text === 'string') {
						response += update.content.text;
						if (Buffer.byteLength(response) > 4 * 1024 * 1024) { controller.abort(new Error('ACP response exceeds byte limit')); return; }
						emit({ type: 'token', token: update.content.text });
					} else if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
						const previous = tools.get(update.toolCallId);
						const tool = { kind: update.kind ?? previous?.kind, locations: update.locations ?? previous?.locations, name: update.title ?? previous?.name ?? update.kind ?? 'Agent tool', input: object(update.rawInput) ? update.rawInput : previous?.input ?? {} };
						if (tools.size >= 1024 && !previous) { controller.abort(new Error('ACP tool event limit reached')); return; }
						tools.set(update.toolCallId, tool);
						if (update.status === 'completed' && (tool.kind === 'edit' || tool.kind === 'delete') && Array.isArray(tool.locations)) {
							for (const location of tool.locations) {
								if (!object(location) || typeof location.path !== 'string') { continue; }
								const relative = path.relative(this.cwd, path.resolve(this.cwd, location.path));
								if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
									options?.onReportedChange?.({ filePath: relative, changeType: tool.kind === 'delete' ? 'delete' : 'modify' });
								}
							}
						}
						emit({ type: 'tool-call', id: update.toolCallId, ...tool, status: update.status === 'failed' ? 'error' : update.status === 'completed' ? 'done' : 'running', output: update.rawOutput === undefined ? undefined : JSON.stringify(update.rawOutput) });
					}
				},
			});
			if (result.stopReason !== 'end_turn') { throw new Error(`ACP agent stopped: ${result.stopReason}`); }
			this.agentManager.completeTask(task.id);
			return response;
		} catch (error) { this.agentManager.failTask(task.id, error instanceof Error ? error.message : 'ACP agent failed'); throw error; }
		finally {
			subscription.dispose();
			if (options?.conversationId) {
				const turns = this.history.get(conversationId) ?? [];
				turns.push(`User: ${text}\nAssistant: ${response}`);
				while (turns.length && Buffer.byteLength(turns.join('\n')) > 256 * 1024) { turns.shift(); }
				this.history.delete(conversationId); this.history.set(conversationId, turns);
				while (this.history.size > 20) { this.history.delete(this.history.keys().next().value!); }
			}
		}
	}
}
