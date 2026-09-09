/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { AcpConnection } from './AcpConnection';
import { beginAcpModelCatalog, discoveredAcpModelId } from '../llm/DiscoveredModels';
import { AcpSessionStore, type AcpSessionRecord } from './AcpSessionStore';
import { abortError, cancelledPermission, object, validateImages, type AcpCapabilities, type AcpImage, type AcpUsage, type AcpAgentDefinition, type AcpMcpServer, type AcpPermissionHandler, type AcpPromptResult, type AcpUpdate } from './protocol';

export interface AcpTurn {
	agent: AcpAgentDefinition;
	cwd: string;
	/** Stable per conversation and specialist. Never share this across unrelated work. */
	conversationId: string;
	/** Defaults to true. One-shot callers with their own durable results can skip host recovery reads and writes. */
	persistRecovery?: boolean;
	text: string;
	images?: readonly AcpImage[];
	/** Read-only mode must also be explicitly negotiated through modeId. */
	readOnly?: boolean;
	maxToolCalls?: number;
	onUsage?: (usage: AcpUsage) => void;
	onRecovery?: (state: 'resumed' | 'transcript' | 'interrupted') => void;
	/** Used only if a process was recreated, to restore host-owned conversation context. */
	initialContext?: string;
	mcpServers?: AcpMcpServer[];
	/** Explicit advertised session mode, included in the process reuse key. */
	modeId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	onUpdate?: (update: AcpUpdate) => void;
	onPermission?: AcpPermissionHandler;
}
interface Worker { key: string; connection: AcpConnection; busy: boolean; lastUsed: number; ready: boolean }
interface Job { publishModels: ReturnType<typeof beginAcpModelCatalog>; key: string; turn: AcpTurn; controller: AbortController; finish(error?: Error, result?: AcpPromptResult): void; abort(): void }

export interface AcpRecoveryStorageIssue {
	phase: 'read' | 'before-prompt' | 'after-prompt';
	code: 'EACCES' | 'EPERM' | 'EROFS' | 'ENOSPC' | 'EDQUOT' | 'unavailable';
	contextLimited: boolean;
}

/** Shared process budget, fair bounded queue, conversation isolation and idle process reuse. */
export class AcpRuntime {
	private readonly workers = new Map<string, Worker>();
	private readonly queue: Job[] = [];
	private readonly active = new Set<Job>();
	private readonly reaper: ReturnType<typeof setInterval>;
	private disposed = false;
	private pumping = false;
	private readonly stopping = new Set<Promise<void>>();
	private readonly executions = new Map<Job, Promise<void>>();
	private readonly capabilities = new Map<string, AcpCapabilities>();
	private readonly sessionStore?: AcpSessionStore;
	private readonly onRecoveryStorageIssue: (issue: AcpRecoveryStorageIssue) => void | Promise<void>;
	private completed = 0;
	private failed = 0;
	private reused = 0;
	readonly maxProcesses: number;
	readonly maxQueue: number;
	readonly idleTimeoutMs: number;

	constructor(options: { maxProcesses?: number; maxQueue?: number; idleTimeoutMs?: number; sessionStore?: AcpSessionStore; onRecoveryStorageIssue?: (issue: AcpRecoveryStorageIssue) => void | Promise<void> } = {}) {
		this.sessionStore = options.sessionStore;
		this.onRecoveryStorageIssue = options.onRecoveryStorageIssue ?? (issue => console.warn('[acp] Crash recovery storage is unavailable; agent execution can continue.', issue));
		this.maxProcesses = bounded(options.maxProcesses, 4, 1, 32);
		this.maxQueue = bounded(options.maxQueue, 32, 1, 256);
		this.idleTimeoutMs = bounded(options.idleTimeoutMs, 300_000, 1_000, 3_600_000);
		this.reaper = setInterval(() => {
			for (const worker of this.workers.values()) {
				if (!worker.busy && Date.now() - worker.lastUsed >= this.idleTimeoutMs) { this.retire(worker); }
			}
		}, Math.min(this.idleTimeoutMs, 30_000));
		this.reaper.unref();
	}

	run(turn: AcpTurn): Promise<AcpPromptResult> {
		try { validateImages(turn.images); } catch (error) { return Promise.reject(error); }
		if (turn.readOnly && !turn.modeId) { return Promise.reject(new Error('Read-only ACP execution requires an explicit advertised session mode')); }
		if (this.disposed) { return Promise.reject(new Error('ACP runtime is shut down')); }
		if (turn.signal?.aborted) { return Promise.reject(abortError()); }
		if (!isAbsolute(turn.cwd) || !turn.conversationId || !turn.text.trim()) { return Promise.reject(new Error('ACP turn requires an absolute cwd, conversation id and text')); }
		if (this.queue.length >= this.maxQueue) { return Promise.reject(new Error('ACP request queue is full')); }
		const key = this.key(turn);
		return new Promise((resolve, reject) => {
			const controller = new AbortController();
			let done = false;
			let remaining = bounded(turn.timeoutMs, 300_000, 1, 3_600_000);
			let started = Date.now(), permissionDepth = 0;
			let permissionTimeout: ReturnType<typeof setTimeout> | undefined;
			let timeout: ReturnType<typeof setTimeout>;
			const arm = () => { started = Date.now(); timeout = setTimeout(() => controller.abort(new Error('ACP turn deadline exceeded')), remaining); };
			arm();
			const permission: AcpPermissionHandler | undefined = turn.onPermission && (async (request, signal) => {
				if (permissionDepth++ === 0) {
					clearTimeout(timeout); remaining = Math.max(1, remaining - (Date.now() - started));
					permissionTimeout = setTimeout(() => controller.abort(new Error('ACP permission request timed out')), 600_000);
				}
				try { return await turn.onPermission!(request, signal); }
				finally { if (--permissionDepth === 0) { clearTimeout(permissionTimeout); if (!done && !controller.signal.aborted) { arm(); } } }
			});
			const externalAbort = () => controller.abort(abortError());
			const job: Job = {
				key, turn: { ...turn, onPermission: permission }, controller, publishModels: beginAcpModelCatalog(turn.agent),
				finish: (error, result) => {
					if (done) { return; } done = true;
					clearTimeout(timeout); clearTimeout(permissionTimeout); turn.signal?.removeEventListener('abort', externalAbort); controller.signal.removeEventListener('abort', job.abort);
					if (error) { this.failed++; reject(error); } else { this.completed++; resolve(result!); }
				},
				abort: () => {
					const index = this.queue.indexOf(job);
					if (index !== -1) { this.queue.splice(index, 1); job.finish(controller.signal.reason as Error); }
				},
			};
			turn.signal?.addEventListener('abort', externalAbort, { once: true });
			controller.signal.addEventListener('abort', job.abort, { once: true });
			this.queue.push(job);
			void this.pump();
		});
	}

	snapshot(): { processes: number; active: number; queued: number; completed: number; failed: number; reused: number; maxProcesses: number } {
		return { processes: this.workers.size, active: this.active.size, queued: this.queue.length, completed: this.completed, failed: this.failed, reused: this.reused, maxProcesses: this.maxProcesses };
	}

	getCapabilities(agent: AcpAgentDefinition): AcpCapabilities {
		return this.capabilities.get(createHash('sha256').update(JSON.stringify(agent)).digest('hex'))
			?? { transport: 'acp', images: 'unknown', plan: 'unknown', resume: 'unknown', metering: 'unavailable' };
	}

	/** Release one host conversation, including requests waiting for a process slot. */
	async release(conversationId: string): Promise<void> {
		for (const job of [...this.queue, ...this.active]) { if (job.turn.conversationId === conversationId) { job.controller.abort(abortError()); } }
		for (const worker of this.workers.values()) {
			if (JSON.parse(worker.key)[0] === conversationId) { this.retire(worker); }
		}
		await Promise.allSettled(this.stopping);
	}

	/** Permanently remove only this host conversation's recovery records, after its active writes settle. */
	async forgetConversation(conversationId: string): Promise<void> {
		const matches = (owner: string) => owner === conversationId || owner.endsWith(`:${conversationId}`);
		const running = [...this.executions.entries()].filter(([job]) => matches(job.turn.conversationId)).map(([, execution]) => execution);
		for (const job of [...this.queue, ...this.active]) { if (matches(job.turn.conversationId)) { job.controller.abort(abortError()); } }
		for (const worker of this.workers.values()) { if (matches(JSON.parse(worker.key)[0])) { this.retire(worker); } }
		await Promise.allSettled(running);
		await this.sessionStore?.forgetConversation(conversationId);
	}

	async shutdown(): Promise<void> {
		if (this.disposed) { await Promise.allSettled(this.stopping); return; }
		this.disposed = true; clearInterval(this.reaper);
		for (const job of [...this.queue, ...this.active]) { job.controller.abort(abortError()); }
		for (const worker of this.workers.values()) { this.retire(worker); }
		await Promise.allSettled([...this.stopping, ...this.executions.values()]);
	}

	private key(turn: AcpTurn): string {
		// Hash invocation configuration: environment secrets must not appear in diagnostics or keys.
		const configuration = [turn.agent, turn.mcpServers ?? [], turn.modeId, turn.readOnly];
		// Keep existing durable recovery keys unchanged, while preventing a
		// one-shot caller from reusing a durable conversation's remote session.
		if (turn.persistRecovery === false) { configuration.push('ephemeral'); }
		const fingerprint = createHash('sha256').update(JSON.stringify(configuration)).digest('hex');
		return JSON.stringify([turn.conversationId, turn.cwd, fingerprint]);
	}

	private reportRecoveryStorageIssue(phase: AcpRecoveryStorageIssue['phase'], error: unknown): void {
		// Storage errors may embed paths, transcripts or secrets. Emit no raw error
		// properties beyond this closed set of diagnostic codes.
		const rawCode = object(error) ? error.code : undefined;
		const code = rawCode === 'EACCES' || rawCode === 'EPERM' || rawCode === 'EROFS' || rawCode === 'ENOSPC' || rawCode === 'EDQUOT' ? rawCode : 'unavailable';
		try { void Promise.resolve(this.onRecoveryStorageIssue({ phase, code, contextLimited: this.sessionStore?.recoveryContextLimited === true })).catch(() => {}); } catch { /* Diagnostics must not fail execution. */ }
	}

	/** Stop waiting for optional persistence on abort without reordering or abandoning its write. */
	private async saveRecoveryRecord(job: Job, record: AcpSessionRecord, phase: 'before-prompt' | 'after-prompt'): Promise<void> {
		if (!this.sessionStore) { return; }
		const signal = job.controller.signal;
		let onAbort: (() => void) | undefined;
		try {
			const saving = this.sessionStore.save(job.key, record);
			if (signal.aborted) {
				// An already-cancelled prompt still records its interruption, but
				// cancellation alone is not evidence that storage is unavailable.
				void saving.catch(error => this.reportRecoveryStorageIssue(phase, error));
				return;
			}
			const aborted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener('abort', onAbort, { once: true });
				if (signal.aborted) { onAbort(); }
			});
			// The race consumes late write failures. The store keeps its FIFO so a
			// following turn or permanent deletion cannot overtake this write.
			await Promise.race([saving, aborted]);
		} catch (error) { this.reportRecoveryStorageIssue(phase, error); }
		finally { if (onAbort) { signal.removeEventListener('abort', onAbort); } }
	}

	private retire(worker: Worker): void {
		if (this.workers.get(worker.key) === worker) { this.workers.delete(worker.key); }
		const stop = worker.connection.stop();
		this.stopping.add(stop);
		void stop.finally(() => { this.stopping.delete(stop); void this.pump(); });
	}

	private async pump(): Promise<void> {
		if (this.pumping || this.disposed) { return; }
		this.pumping = true;
		try {
			while (this.queue.length && !this.disposed) {
				// A busy conversation must not block unrelated work behind it.
				const index = this.queue.findIndex(job => !this.workers.get(job.key)?.busy);
				if (index === -1) { break; }
				const job = this.queue[index];
				let worker = this.workers.get(job.key);
				if (worker && !worker.connection.isConnected) { this.retire(worker); worker = undefined; }
				if (!worker && this.workers.size + this.stopping.size >= this.maxProcesses) {
					const idle = [...this.workers.values()].filter(item => !item.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
					if (!idle) { break; }
					this.retire(idle);
					await Promise.allSettled(this.stopping);
					continue;
				}
				this.queue.splice(index, 1);
				if (job.controller.signal.aborted) { job.finish(job.controller.signal.reason as Error); continue; }
				if (!worker) {
					try { worker = { key: job.key, connection: new AcpConnection(job.turn.agent, job.turn.cwd), busy: false, lastUsed: Date.now(), ready: false }; }
					catch (error) { job.finish(error as Error); continue; }
					this.workers.set(job.key, worker);
				} else { this.reused++; }
				worker.busy = true; this.active.add(job);
				const execution = this.execute(worker, job);
				this.executions.set(job, execution);
				void execution.finally(() => this.executions.delete(job));
			}
		} finally { this.pumping = false; }
	}

	private async execute(worker: Worker, job: Job): Promise<void> {
		let record: AcpSessionRecord | undefined;
		let response = '';
		const toolStates = new Map<string, string>();
		const knownTools = new Set<string>();
		const maxToolCalls = bounded(job.turn.maxToolCalls, 100, 0, 1000);
		let promptStarted = false;
		let completedResult: AcpPromptResult | undefined;
		let failure: Error | undefined;
		const countTool = (id: string): boolean => {
			knownTools.add(id);
			if (knownTools.size > maxToolCalls) { job.controller.abort(new Error(`ACP tool-call budget reached (${maxToolCalls})`)); return false; }
			return true;
		};
		const negotiateSession = async (open: () => Promise<unknown>): Promise<void> => {
			try { await open(); }
			finally {
				// Even an unavailable selected model can accompany a valid new catalog.
				// Reused workers never republish their older session's advertised list.
				const connection = worker.connection;
				if (connection.modelsAdvertised) {
					const entries = connection.availableModels.map(model => ({
						id: discoveredAcpModelId(job.turn.agent.id, model.id), provider: 'acp' as const, acpAdapterId: job.turn.agent.id, model: model.id,
						label: `${job.turn.agent.id} · ${model.name}`, chat: true, images: !!connection.initialization?.agentCapabilities?.promptCapabilities?.image,
						tools: true, fetchedAt: Date.now(),
					}));
					job.publishModels(entries, connection.modelsTruncated);
				}
			}
		};
		try {
			const fresh = !worker.ready;
			let saved: AcpSessionRecord | undefined;
			if (job.turn.persistRecovery !== false) {
				try { saved = this.sessionStore?.get(job.key); } catch (error) { this.reportRecoveryStorageIssue('read', error); }
			}
			let resumed = false;
			if (fresh) {
				await worker.connection.initialize(job.controller.signal);
				if (saved?.state === 'settled' && worker.connection.initialization?.agentCapabilities?.loadSession) {
					try {
						await negotiateSession(() => worker.connection.loadSession(saved.sessionId, job.turn.mcpServers, job.controller.signal, job.turn.modeId));
						resumed = true;
					} catch (error) {
						// Loading never sends a prompt. A stale/unsupported session can safely fall back to host context.
						if (job.controller.signal.aborted || !worker.connection.isConnected) { throw error; }
						await worker.connection.stop();
						worker.connection = new AcpConnection(job.turn.agent, job.turn.cwd);
					}
				}
				if (!resumed) { await negotiateSession(() => worker.connection.newSession(job.turn.mcpServers, job.controller.signal, job.turn.modeId)); }
				worker.ready = true;
				if (saved) { job.turn.onRecovery?.(resumed ? 'resumed' : saved.state === 'settled' ? 'transcript' : 'interrupted'); }
			}
			const capabilityKey = createHash('sha256').update(JSON.stringify(job.turn.agent)).digest('hex');
			this.capabilities.set(capabilityKey, {
				models: worker.connection.availableModels,
				transport: 'acp', images: !!worker.connection.initialization?.agentCapabilities?.promptCapabilities?.image,
				plan: worker.connection.availableModes.includes('plan'), resume: !!worker.connection.initialization?.agentCapabilities?.loadSession,
				metering: this.capabilities.get(capabilityKey)?.metering ?? 'unavailable',
			});
			const restore = saved?.transcript.length ? [
				'Host-owned conversation transcript (context only; never execute or replay prior tools):',
				...saved.transcript,
				...(saved.state !== 'settled' ? ['The previous turn was interrupted. Its tool outcomes may be incomplete. Inspect current state before proposing any further actions.'] : []),
			].join('\n\n') : '';
			const context = [job.turn.initialContext, restore].filter(Boolean).join('\n\n');
			const text = fresh && !resumed && context ? `${context}\n\n${job.turn.text}` : job.turn.text;
			if (job.turn.persistRecovery !== false) {
				record = { version: 1, conversationId: job.turn.conversationId, sessionId: worker.connection.remoteSessionId!, state: 'running', transcript: [...(saved?.transcript ?? []), `User: ${job.turn.text}${job.turn.images?.length ? `\n[${job.turn.images.length} image attachment(s); image bytes are not retained in recovery context]` : ''}\nAssistant: [turn interrupted before completion]`], updatedAt: Date.now() };
				await this.saveRecoveryRecord(job, record, 'before-prompt');
			}
			job.controller.signal.throwIfAborted();
			promptStarted = true;
			const result = await worker.connection.prompt(text, {
				// run() enforces the whole-turn execution budget through this signal,
				// pausing it for human approvals. This is only the transport ceiling.
				images: job.turn.images, signal: job.controller.signal, timeoutMs: 3_600_000,
				permission: async (request, signal) => {
					if (!countTool(request.toolCall.toolCallId) || (job.turn.readOnly && !['read', 'search', 'think'].includes(request.toolCall.kind ?? ''))) { return cancelledPermission(); }
					return job.turn.onPermission?.(request, signal) ?? cancelledPermission();
				},
				update: update => {
					if (update.sessionUpdate === 'agent_message_chunk' && object(update.content) && typeof update.content.text === 'string') { response = (response + update.content.text).slice(-64 * 1024); }
					if (update.toolCallId && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')) {
						if (!countTool(update.toolCallId)) { return; }
						toolStates.set(update.toolCallId, `${update.title ?? update.toolCallId}: ${update.status ?? 'running'}`);
						if (job.turn.readOnly && ['edit', 'delete', 'execute', 'move'].includes(update.kind ?? '')) { job.controller.abort(new Error('ACP adapter attempted a mutating tool in Plan mode')); return; }
					}
					if (job.turn.readOnly && update.sessionUpdate === 'current_mode_update' && update.modeId !== job.turn.modeId) { job.controller.abort(new Error('ACP adapter left the required read-only mode')); return; }
					if (update.sessionUpdate === 'usage_update') {
						const usage: AcpUsage = {};
						if (finiteNonnegative(update.used)) { usage.contextTokens = update.used; }
						if (finiteNonnegative(update.size)) { usage.contextWindow = update.size; }
						if (object(update.cost) && finiteNonnegative(update.cost.amount) && typeof update.cost.currency === 'string' && /^[A-Z]{3}$/.test(update.cost.currency)) {
							usage.cost = { amount: update.cost.amount, currency: update.cost.currency };
							this.capabilities.get(capabilityKey)!.metering = 'reported';
						}
						job.turn.onUsage?.(usage);
					}
					job.turn.onUpdate?.(update);
				},
			});
			if (record) { record.state = result.stopReason === 'end_turn' ? 'settled' : 'interrupted'; }
			completedResult = result;
		} catch (error) {
			if (record) { record.state = 'interrupted'; }
			this.retire(worker);
			failure = job.controller.signal.aborted ? job.controller.signal.reason as Error : error as Error;
		} finally {
			if (record && promptStarted) {
				record.transcript[record.transcript.length - 1] = `User: ${job.turn.text}${job.turn.images?.length ? `\n[${job.turn.images.length} image attachment(s); reattach if needed]` : ''}\nAssistant: ${response}\nTurn: ${record.state}${toolStates.size ? `\nReported tools (never replay): ${[...toolStates.values()].join('; ')}` : ''}`;
				// Once the prompt has finished, a deadline or cancellation while
				// persisting optional recovery data must not replace its outcome.
				await this.saveRecoveryRecord(job, record, 'after-prompt');
			}
			worker.busy = false; worker.lastUsed = Date.now(); this.active.delete(job);
			job.finish(failure, completedResult);
			void this.pump();
		}
	}

}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
	return value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
