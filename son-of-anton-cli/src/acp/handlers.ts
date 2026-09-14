/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ACP_VERSION, AcpError, object, type AcpMcpServer, type AcpPermissionResult, type AcpPromptResult, type AcpUpdate } from 'son-of-anton-core/dist/acp/protocol';
import type { AgentStack } from 'son-of-anton-core/dist/agents/AgentStackFactory';
import type { AgentHandle } from 'son-of-anton-core/dist/agents/types';
import type { ChatRequestLike, ChatStreamLike } from 'son-of-anton-core/dist/chatStream';
import type { ApprovalGate } from '../approval';
import { CliCancellation } from '../cancellation';

interface Session {
	id: string;
	cwd: string;
	mode: AgentHandle | 'council-review';
	built: { stack?: AgentStack; review?(text: string, signal: AbortSignal, onText: (text: string) => void): Promise<void>; dispose(): void };
	history: Array<{ role: string; content: string }>;
	active?: { cancellation: CliCancellation; controller: AbortController };
}
export interface HandlerDeps {
	createSession(cwd: string, servers: AcpMcpServer[], approvalGate: ApprovalGate): Promise<Session['built']>;
	sendNotification(method: string, params: unknown): void;
	requestPermission(params: unknown, signal: AbortSignal): Promise<AcpPermissionResult>;
	hasCredentials(): Promise<boolean>;
	defaultAgent?: string;
	maxSessions?: number;
}

/** Independent stacks keep cwd, plans, memory and approvals isolated for each ACP session. */
export class AcpHandlers {
	private initialized = false;
	private disposed = false;
	private creating = 0;
	private readonly sessions = new Map<string, Session>();
	constructor(private readonly deps: HandlerDeps) {}

	async invoke(method: string, params: unknown): Promise<unknown> {
		if (this.disposed) { throw new AcpError(-32600, 'ACP server is closing'); }
		if (method === 'initialize') {
			if (!object(params) || !Number.isInteger(params.protocolVersion)) { throw new AcpError(-32602, 'initialize requires protocolVersion'); }
			this.initialized = params.protocolVersion === ACP_VERSION;
			return { protocolVersion: ACP_VERSION, agentInfo: { name: 'son-of-anton', version: '1.0.0' }, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } }, authMethods: [] };
		}
		if (!this.initialized) { throw new AcpError(-32600, 'Initialize the ACP connection first'); }
		switch (method) {
			case 'authenticate':
				if (!await this.deps.hasCredentials()) { throw new AcpError(-32000, 'Configure provider credentials using sota auth or environment variables before starting this agent'); }
				return {};
			case 'session/new': return this.newSession(params);
			case 'session/prompt': return this.prompt(params);
			case 'session/cancel': this.cancel(params); return null;
			case 'session/set_mode': {
				const session = this.requireSession(params);
				if (session.active) { throw new AcpError(-32600, 'Cannot change agent during a prompt'); }
				const mode = (params as { modeId?: string }).modeId;
				if (!mode || (session.built.review ? mode !== 'council-review' : mode !== 'anton' && !session.built.stack?.specialists.has(mode as AgentHandle))) { throw new AcpError(-32602, 'Unknown agent mode'); }
				session.mode = mode as Session['mode'];
				return {};
			}
			default: throw new AcpError(-32601, `Unsupported ACP method: ${method}`);
		}
	}

	cancel(params: unknown): void {
		if (!object(params) || typeof params.sessionId !== 'string') { return; }
		const active = this.sessions.get(params.sessionId)?.active;
		active?.controller.abort(); active?.cancellation.cancel();
	}

	dispose(): void {
		this.disposed = true;
		for (const session of this.sessions.values()) { this.cancel({ sessionId: session.id }); session.built.dispose(); }
		this.sessions.clear();
	}

	private async newSession(params: unknown): Promise<unknown> {
		if (!object(params) || typeof params.cwd !== 'string' || !isAbsolute(params.cwd) || !Array.isArray(params.mcpServers)) { throw new AcpError(-32602, 'session/new requires absolute cwd and mcpServers array'); }
		const servers = parseServers(params.mcpServers);
		if (this.sessions.size + this.creating >= (this.deps.maxSessions ?? 16)) { throw new AcpError(-32004, 'ACP session limit reached; open a new agent process'); }
		this.creating++;
		try {
			const cwd = await realpath(params.cwd);
			if (!(await stat(cwd)).isDirectory()) { throw new AcpError(-32602, 'cwd must be a directory'); }
			const id = randomUUID();
			const approvalGate: ApprovalGate = async request => {
				const active = this.sessions.get(id)?.active;
				if (!active || active.controller.signal.aborted) { return { approved: false, reason: 'ACP turn cancelled' }; }
				const toolCallId = randomUUID();
				const toolCall = { toolCallId, title: request.detail, kind: request.kind === 'write' ? 'edit' : 'execute', status: 'pending' };
				this.send(id, { sessionUpdate: 'tool_call', ...toolCall });
				const result = await this.deps.requestPermission({ sessionId: id, toolCall, options: [
					{ optionId: 'allow', name: 'Allow Once', kind: 'allow_once' },
					{ optionId: 'reject', name: 'Reject', kind: 'reject_once' },
				] }, active.controller.signal);
				const approved = !active.controller.signal.aborted && result?.outcome?.outcome === 'selected' && result.outcome.optionId === 'allow';
				this.send(id, { sessionUpdate: 'tool_call_update', toolCallId, status: approved ? 'completed' : 'failed', rawOutput: { permission: approved ? 'allowed' : 'denied' } });
				return { approved, reason: approved ? undefined : 'ACP permission declined or cancelled' };
			};
			const built = await this.deps.createSession(cwd, servers, approvalGate);
			if (this.disposed) { built.dispose(); throw new AcpError(-32600, 'ACP server is closing'); }
			const mode = built.review ? 'council-review' : this.deps.defaultAgent ?? 'anton';
			if (mode !== 'council-review' && mode !== 'anton' && !built.stack?.specialists.has(mode as AgentHandle)) { built.dispose(); throw new AcpError(-32602, `Unknown agent: ${mode}`); }
			this.sessions.set(id, { id, cwd, mode: mode as Session['mode'], built, history: [] });
			return { sessionId: id, modes: { currentModeId: mode, availableModes: [
				...(built.review ? [{ id: 'council-review', name: 'Council Review', description: 'Review supplied evidence without tools, files, commands, or memory' }] : [{ id: 'anton', name: 'Anton', description: 'Plan and coordinate specialist work' }, ...[...built.stack!.specialists].map(([id, agent]) => ({ id, name: agent.displayName }))]),
			] } };
		} finally { this.creating--; }
	}

	private async prompt(params: unknown): Promise<AcpPromptResult> {
		const session = this.requireSession(params);
		if (session.active) { throw new AcpError(-32600, 'A prompt is already running in this session'); }
		const text = extractPrompt((params as { prompt?: unknown }).prompt);
		const active = { cancellation: new CliCancellation(), controller: new AbortController() };
		session.active = active;
		let response = '';
		let reportedError: string | undefined;
		const send = (update: AcpUpdate) => { if (!active.controller.signal.aborted) { this.send(session.id, update); } };
		const stream: ChatStreamLike = { markdown: chunk => {
			if (active.controller.signal.aborted) { return; }
			response += chunk;
			if (Buffer.byteLength(response) > 4 * 1024 * 1024) { this.cancel({ sessionId: session.id }); throw new AcpError(-32004, 'Response exceeds byte limit'); }
			send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
		} };
		try {
			const history = session.history.length ? `Previous conversation (context):\n${JSON.stringify(session.history)}` : undefined;
			if (session.mode === 'council-review') {
				await session.built.review!(text, active.controller.signal, chunk => stream.markdown(chunk));
			} else if (session.mode === 'anton') {
				const slash = /^\/(plan|approve|reject|status|metrics)\b\s*/.exec(text);
				const request: ChatRequestLike = { prompt: slash ? text.slice(slash[0].length) : text, command: slash?.[1], conversationId: session.id, workspaceContextSnapshot: history };
				await session.built.stack!.orchestrator.handleChatRequest(request, { history: session.history }, stream, active.cancellation, event => {
					if (event.type === 'error') { reportedError = event.message; }
					if (event.type === 'plan-proposed') { send({ sessionUpdate: 'plan', entries: event.plan.subtasks.map(task => ({ content: `@${task.assignee}: ${task.instruction}`, priority: 'medium', status: 'pending' })) }); }
					if (event.type === 'subtask-started') { send({ sessionUpdate: 'tool_call', toolCallId: event.subtaskId, title: `@${event.assignee}: ${event.instruction}`, kind: 'think', status: 'in_progress' }); }
					if (event.type === 'subtask-completed' || event.type === 'subtask-failed') { send({ sessionUpdate: 'tool_call_update', toolCallId: event.subtaskId, status: event.type === 'subtask-completed' ? 'completed' : 'failed' }); }
				});
			} else {
				await session.built.stack!.specialists.get(session.mode)!.runAgenticTurn(text, event => {
					if (event.type === 'token') { stream.markdown(event.token); }
					else { send({ sessionUpdate: event.status === 'running' ? 'tool_call' : 'tool_call_update', toolCallId: event.id, title: event.name, kind: 'other', status: event.status === 'running' ? 'in_progress' : event.status === 'done' ? 'completed' : 'failed', rawInput: event.input, rawOutput: event.output }); }
				}, active.cancellation, { conversationId: session.id, workspaceContextSnapshot: history });
			}
			if (reportedError && !active.controller.signal.aborted) { throw new AcpError(-32603, reportedError); }
			return { stopReason: active.controller.signal.aborted ? 'cancelled' : 'end_turn' };
		} catch (error) { if (active.controller.signal.aborted) { return { stopReason: 'cancelled' }; } throw error; }
		finally {
			session.history.push({ role: 'user', content: text });
			if (response) { session.history.push({ role: 'assistant', content: response }); }
			while (session.history.length > 2 && (session.history.length > 40 || Buffer.byteLength(JSON.stringify(session.history)) > 256 * 1024)) { session.history.splice(0, 2); }
			if (session.active === active) { session.active = undefined; }
		}
	}

	private requireSession(params: unknown): Session {
		if (!object(params) || typeof params.sessionId !== 'string') { throw new AcpError(-32602, 'sessionId is required'); }
		const session = this.sessions.get(params.sessionId);
		if (!session) { throw new AcpError(-32002, 'Session not found'); }
		return session;
	}
	private send(sessionId: string, update: AcpUpdate): void { if (!this.disposed) { this.deps.sendNotification('session/update', { sessionId, update }); } }
}

function extractPrompt(prompt: unknown): string {
	if (!Array.isArray(prompt) || prompt.length > 1024) { throw new AcpError(-32602, 'prompt must be a content block array'); }
	const text = prompt.map(block => {
		if (!object(block)) { throw new AcpError(-32602, 'Invalid content block'); }
		if (block.type === 'text' && typeof block.text === 'string') { return block.text; }
		if (block.type === 'resource_link' && typeof block.uri === 'string') { return `Referenced resource: ${block.uri}`; }
		if (block.type === 'resource' && object(block.resource) && typeof block.resource.text === 'string') { return `Resource ${block.resource.uri ?? ''}:\n${block.resource.text}`; }
		throw new AcpError(-32602, 'Unsupported prompt content; this agent accepts text and text resources');
	}).join('\n');
	if (!text.trim()) { throw new AcpError(-32602, 'Prompt is empty'); }
	return text;
}
function parseServers(value: unknown[]): AcpMcpServer[] {
	if (value.length > 32) { throw new AcpError(-32602, 'Too many MCP servers'); }
	const names = new Set<string>();
	for (const server of value) {
		if (!object(server) || typeof server.name !== 'string' || names.has(server.name) || typeof server.command !== 'string' || !server.command || !Array.isArray(server.args) || !server.args.every(arg => typeof arg === 'string') || !Array.isArray(server.env) || !server.env.every(env => object(env) && typeof env.name === 'string' && typeof env.value === 'string')) { throw new AcpError(-32602, 'Only named MCP stdio servers with command, args and env are supported'); }
		names.add(server.name);
	}
	return value as AcpMcpServer[];
}
