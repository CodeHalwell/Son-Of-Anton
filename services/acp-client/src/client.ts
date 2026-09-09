/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { AcpRuntime } from '../_shared/acp/dist/acp/AcpRuntime';
import { AcpConnection } from '../_shared/acp/dist/acp/AcpConnection';
import { cancelledPermission, object, type AcpPermissionRequest, type AcpPermissionResult, type AcpUpdate } from '../_shared/acp/dist/acp/protocol';
import { AgentRegistry } from './registry/agentRegistry';
import type { ACPClient, AgentCapabilities, Session, SessionConfig, SessionContext, SessionEvent, SessionStatus } from './types';

interface ManagedSession {
	session: Session;
	config: SessionConfig;
	cwd: string;
	history: string[];
	handlers: Set<(event: SessionEvent) => void>;
	controller?: AbortController;
}
interface Permission { id: string; sessionId: string; request: AcpPermissionRequest; finish(result: AcpPermissionResult): void }

/** HTTP-facing sessions are allocated locally; the shared runtime starts ACP on the first prompt. */
export class ACPClientImpl extends EventEmitter implements ACPClient {
	readonly runtime: AcpRuntime;
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly permissions = new Map<string, Permission>();
	private readonly probes = new Map<string, Promise<AgentCapabilities>>();
	private readonly probeConnections = new Set<AcpConnection>();
	private readonly capabilities = new Map<string, { signature: string; expires: number; value: AgentCapabilities }>();
	private readonly reaper: ReturnType<typeof setInterval>;
	private closed = false;
	constructor(private readonly registry: AgentRegistry, private readonly workspaceRoot = process.env.PROJECT_PATH ?? process.cwd(), runtime = new AcpRuntime()) {
		super(); this.runtime = runtime;
		this.reaper = setInterval(() => {
			for (const managed of this.sessions.values()) { if (!managed.controller && Date.now() - managed.session.updatedAt > 30 * 60_000) { void this.terminateSession(managed.session.id); } }
		}, 60_000);
		this.reaper.unref();
	}
	async listAgents() { return this.registry.listDescriptors(); }
	async getAgentCapabilities(agentId: string): Promise<AgentCapabilities> {
		if (this.closed) { throw new Error('ACP client is shutting down'); }
		const entry = this.registry.getEntry(agentId);
		if (!entry) { throw new Error(`Agent not found: ${agentId}`); }
		const signature = JSON.stringify(entry);
		const cached = this.capabilities.get(agentId);
		if (cached && cached.signature === signature && cached.expires > Date.now()) { return cached.value; }
		const existing = this.probes.get(agentId);
		if (existing) { return existing; }
		if (this.probes.size >= 4) { throw new Error('ACP capability probe limit reached'); }
		const probe = (async () => {
			const connection = new AcpConnection({ ...entry, command: entry.command! }, this.workspaceRoot);
			this.probeConnections.add(connection);
			try {
				const result = await connection.initialize();
				const value = { ...AgentRegistry.entryToCapabilities(entry), protocolVersion: result.protocolVersion, connected: true, providerReadinessChecked: false, protocolCapabilities: result.agentCapabilities, authMethods: result.authMethods };
				this.capabilities.set(agentId, { signature, expires: Date.now() + 60_000, value });
				return value;
			} finally { await connection.stop(); this.probeConnections.delete(connection); this.probes.delete(agentId); }
		})();
		this.probes.set(agentId, probe);
		return probe;
	}
	async createSession(agentId: string, config: SessionConfig): Promise<Session> {
		if (this.closed) { throw new Error('ACP client is shutting down'); }
		if (!this.registry.has(agentId)) { throw new Error(`Agent not found: ${agentId}`); }
		if (this.sessions.size >= 128) { throw new Error('ACP session limit reached'); }
		if (!config || typeof config !== 'object' || Array.isArray(config) || (config.task !== undefined && typeof config.task !== 'string')) { throw new Error('Invalid session config'); }
		if (config.tools !== undefined || config.maxTokens !== undefined) { throw new Error('ACP v1 does not support tools/maxTokens session overrides; use mcpServers and agent configuration'); }
		if (config.timeout !== undefined && (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout) || config.timeout <= 0)) { throw new Error('timeout must be a positive number'); }
		if (config.requestPermissions !== undefined && typeof config.requestPermissions !== 'boolean') { throw new Error('requestPermissions must be a boolean'); }
		if (config.cwd !== undefined && typeof config.cwd !== 'string') { throw new Error('cwd must be a string'); }
		const root = await realpath(this.workspaceRoot);
		const cwd = await realpath(config.cwd ?? root);
		if (!(await stat(cwd)).isDirectory()) { throw new Error('cwd must be a directory'); }
		const relative = path.relative(root, cwd);
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { throw new Error('Session cwd must stay inside the configured workspace'); }
		if (config.mcpServers !== undefined && (!Array.isArray(config.mcpServers) || config.mcpServers.length > 32 || !config.mcpServers.every(server => object(server) && typeof server.name === 'string' && typeof server.command === 'string' && Array.isArray(server.args) && server.args.every(arg => typeof arg === 'string') && Array.isArray(server.env) && server.env.every(env => object(env) && typeof env.name === 'string' && typeof env.value === 'string')))) { throw new Error('mcpServers must contain ACP stdio server descriptors'); }
		// Recheck after asynchronous path resolution, so parallel allocations cannot exceed the cap.
		if (this.closed || this.sessions.size >= 128) { throw new Error('ACP session capacity unavailable'); }
		const session: Session = { id: randomUUID(), agentId, status: 'idle', createdAt: Date.now(), updatedAt: Date.now() };
		this.sessions.set(session.id, { session, config: structuredClone(config), cwd, history: [], handlers: new Set() });
		return { ...session };
	}
	async sendMessage(sessionId: string, message: string, context?: SessionContext, signal?: AbortSignal): Promise<void> {
		const managed = this.getSession(sessionId);
		if (managed.controller) { throw new Error('Session already has an active prompt'); }
		if (typeof message !== 'string' || !message.trim()) { throw new Error('A non-empty message is required'); }
		const entry = this.registry.getEntry(managed.session.agentId);
		if (!entry) { throw new Error('Agent was removed from the registry'); }
		const controller = new AbortController(); managed.controller = controller;
		const abort = () => controller.abort();
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) { controller.abort(); }
		managed.session.status = 'running';
		let output = '';
		try {
			const result = await this.runtime.run({
				agent: { ...entry, command: entry.command! }, cwd: managed.cwd, conversationId: sessionId,
				text: context ? `${message}\n\nTask context:\n${JSON.stringify(context)}` : message,
				initialContext: managed.history.length ? `Previous turns:\n${managed.history.join('\n\n')}` : undefined,
				mcpServers: managed.config.mcpServers, signal: controller.signal, timeoutMs: managed.config.timeout,
				onPermission: (request, permissionSignal) => managed.config.requestPermissions ? this.requestPermission(sessionId, request, permissionSignal) : Promise.resolve(cancelledPermission()),
				onUpdate: update => {
					if (update.sessionUpdate === 'agent_message_chunk' && object(update.content) && typeof update.content.text === 'string') { output += update.content.text; }
					if (Buffer.byteLength(output) > 4 * 1024 * 1024) { controller.abort(new Error('ACP output limit exceeded')); return; }
					this.emitEvent(managed, mapUpdate(sessionId, update));
				},
			});
			managed.session.status = result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'terminated' : 'failed';
			this.emitEvent(managed, { type: result.stopReason === 'end_turn' ? 'complete' : 'error', sessionId, timestamp: Date.now(), data: result, requiresApproval: false });
		} catch (error) {
			managed.session.status = controller.signal.aborted ? 'terminated' : 'failed';
			this.emitEvent(managed, { type: 'error', sessionId, timestamp: Date.now(), data: { message: error instanceof Error ? error.message : 'ACP request failed' }, requiresApproval: false });
			throw error;
		} finally {
			managed.history.push(`User: ${message}\nAssistant: ${output}`);
			while (managed.history.length > 1 && Buffer.byteLength(managed.history.join('\n')) > 1024 * 1024) { managed.history.shift(); }
			if (Buffer.byteLength(managed.history[0] ?? '') > 1024 * 1024) { managed.history = []; }
			managed.session.updatedAt = Date.now(); managed.controller = undefined;
			signal?.removeEventListener('abort', abort);
			for (const permission of this.permissions.values()) { if (permission.sessionId === sessionId) { permission.finish(cancelledPermission()); } }
		}
	}
	async pauseSession(_sessionId: string): Promise<void> { throw new Error('ACP v1 has no pause operation; cancel the prompt instead'); }
	async resumeSession(_sessionId: string): Promise<void> { throw new Error('ACP v1 has no pause/resume-turn operation; send a new prompt to continue'); }
	async cancelSession(sessionId: string): Promise<void> { this.getSession(sessionId).controller?.abort(); }
	async terminateSession(sessionId: string): Promise<void> {
		const managed = this.getSession(sessionId); managed.controller?.abort(); this.sessions.delete(sessionId);
		await this.runtime.release(sessionId);
	}
	onSessionEvent(sessionId: string, handler: (event: SessionEvent) => void): void { this.getSession(sessionId).handlers.add(handler); }
	offSessionEvent(sessionId: string, handler: (event: SessionEvent) => void): void { this.sessions.get(sessionId)?.handlers.delete(handler); }
	getActiveSessions(): Session[] { return [...this.sessions.values()].map(managed => ({ ...managed.session })); }
	getSessionStatus(sessionId: string): SessionStatus | undefined { return this.sessions.get(sessionId)?.session.status; }
	getPendingPermissions() { return [...this.permissions.values()].map(({ id, sessionId, request }) => ({ id, sessionId, request })); }
	resolvePermission(id: string, optionId?: string): void {
		const permission = this.permissions.get(id);
		if (!permission) { throw new Error('Permission request not found or expired'); }
		if (optionId && !permission.request.options.some(option => option.optionId === optionId)) { throw new Error('Invalid permission option'); }
		permission.finish(optionId ? { outcome: { outcome: 'selected', optionId } } : cancelledPermission());
	}
	async shutdown(): Promise<void> {
		this.closed = true; clearInterval(this.reaper);
		for (const session of this.sessions.values()) { session.controller?.abort(); }
		for (const permission of this.permissions.values()) { permission.finish(cancelledPermission()); }
		await Promise.allSettled([this.runtime.shutdown(), ...[...this.probeConnections].map(connection => connection.stop())]);
		this.sessions.clear(); this.capabilities.clear();
	}
	private getSession(id: string): ManagedSession { const managed = this.sessions.get(id); if (!managed) { throw new Error(`Session not found: ${id}`); } return managed; }
	private emitEvent(managed: ManagedSession, event: SessionEvent): void {
		for (const handler of managed.handlers) { handler(event); }
		this.emit('sessionEvent', event);
	}
	private requestPermission(sessionId: string, request: AcpPermissionRequest, signal: AbortSignal): Promise<AcpPermissionResult> {
		if (signal.aborted || this.permissions.size >= 64) { return Promise.resolve(cancelledPermission()); }
		return new Promise(resolve => {
			const id = randomUUID();
			const abort = () => finish(cancelledPermission());
			const timer = setTimeout(abort, 120_000);
			const finish = (result: AcpPermissionResult) => { clearTimeout(timer); signal.removeEventListener('abort', abort); this.permissions.delete(id); resolve(result); };
			this.permissions.set(id, { id, sessionId, request, finish });
			signal.addEventListener('abort', abort, { once: true });
			try { this.emitEvent(this.getSession(sessionId), { type: 'permission', sessionId, timestamp: Date.now(), data: { id, request }, requiresApproval: true }); }
			catch { finish(cancelledPermission()); }
		});
	}
}
function mapUpdate(sessionId: string, update: AcpUpdate): SessionEvent {
	const types: Record<string, SessionEvent['type']> = { agent_message_chunk: 'message', tool_call: 'tool_call', tool_call_update: 'tool_call', plan: 'plan' };
	return { type: types[update.sessionUpdate] ?? 'progress', sessionId, timestamp: Date.now(), data: update, requiresApproval: false };
}
