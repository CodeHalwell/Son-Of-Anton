/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import spawn from 'cross-spawn';
import { AcpPeer } from './AcpPeer';
import { ACP_VERSION, AcpError, abortError, cancelledPermission, isValidAcpModelId, object, validateAgent, validateImages, type AcpImage, type AcpAgentDefinition, type AcpInitializeResult, type AcpMcpServer, type AcpPermissionHandler, type AcpPermissionRequest, type AcpPromptResult, type AcpUpdate } from './protocol';

/** One agent process and conversation. Never replays a prompt after a transport failure. */
export class AcpConnection {
	private readonly child: ChildProcessWithoutNullStreams;
	readonly peer: AcpPeer;
	private sessionId?: string;
	private active?: { signal: AbortSignal; update?: (update: AcpUpdate) => void; permission?: AcpPermissionHandler };
	private stopping?: Promise<void>;
	private transportStopping?: Promise<void>;
	private processError?: Error;
	private exited = false;
	private readonly exitPromise: Promise<void>;
	private readonly spawned: Promise<void>;
	initialization?: AcpInitializeResult;
	availableModes: string[] = [];
	availableModels: Array<{ id: string; name: string }> = [];
	modelsAdvertised = false;
	modelsTruncated = false;

	constructor(readonly definition: AcpAgentDefinition, readonly cwd: string) {
		validateAgent(definition);
		this.child = spawn(definition.command, definition.args ?? [], {
			cwd, env: { ...process.env, ...definition.env }, stdio: 'pipe', windowsHide: true,
			detached: process.platform !== 'win32',
		}) as ChildProcessWithoutNullStreams;
		this.peer = new AcpPeer(this.child.stdout, this.child.stdin, {
			request: (method, params) => this.handleRequest(method, params),
			notification: (method, params) => {
				if (method === 'session/update' && object(params) && params.sessionId === this.sessionId && object(params.update) && typeof params.update.sessionUpdate === 'string') {
					if (!this.active?.signal.aborted) { this.active?.update?.(params.update as AcpUpdate); }
				}
			},
			close: () => { void this.stopAfterProcessExit(); },
		}, 4 * 1024 * 1024, 32 * 1024 * 1024);
		// Drain diagnostics without retaining unlimited logs or leaking provider credentials.
		this.child.stderr.resume();
		this.child.stdin.on('error', () => { /* peer handles EPIPE; keep late teardown errors handled */ });
		this.child.stdout.on('error', () => { /* peer handles stream errors */ });
		this.child.stderr.on('error', () => { /* diagnostics are optional */ });
		this.exitPromise = new Promise(resolve => {
			const exit = (error: Error) => { this.processError = error; this.exited = true; this.peer.dispose(error); resolve(); };
			this.child.once('exit', (code, signal) => exit(new Error(`ACP agent ${definition.id} exited (${signal ?? code})`)));
			this.child.once('error', exit);
		});
		this.spawned = new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
		// A spawn error may arrive before initialize is called.
		void this.spawned.catch(() => {});
	}

	get isConnected(): boolean { return this.peer.isConnected && !this.exited; }
	get remoteSessionId(): string | undefined { return this.sessionId; }

	async initialize(signal?: AbortSignal): Promise<AcpInitializeResult> {
		await this.spawned;
		const result = await this.peer.request<AcpInitializeResult>('initialize', {
			protocolVersion: ACP_VERSION,
			clientInfo: { name: 'son-of-anton', version: '1.0.0' },
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		}, { signal }).catch(async error => {
			if (!this.peer.isConnected) {
				await this.stopAfterProcessExit();
				if (!signal?.aborted && ((this.processError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || /^ACP (?:stream closed|connection (?:is )?closed)$/.test(error.message))) {
					throw this.processError ?? error;
				}
			}
			throw error;
		});
		if (!object(result) || result.protocolVersion !== ACP_VERSION) {
			throw new Error(`ACP agent ${this.definition.id} did not negotiate protocol version ${ACP_VERSION}`);
		}
		this.initialization = result;
		if (this.definition.authMethodId) {
			if (!result.authMethods?.some(method => method.id === this.definition.authMethodId)) { throw new Error('Configured ACP authentication method is not advertised by the agent'); }
			await this.peer.request('authenticate', { methodId: this.definition.authMethodId }, { signal });
		}
		return result;
	}

	async newSession(mcpServers: AcpMcpServer[] = [], signal?: AbortSignal, modeId?: string): Promise<string> {
		if (!this.initialization) { await this.initialize(signal); }
		if (this.sessionId) { throw new Error('ACP connection already owns a session'); }
		const result = await this.peer.request<{ sessionId: string; modes?: { availableModes?: Array<{ id: string }> }; models?: { availableModels?: Array<{ modelId: string; name: string }> } }>('session/new', { cwd: this.cwd, mcpServers }, { signal });
		if (!object(result) || typeof result.sessionId !== 'string' || !result.sessionId) { throw new Error('ACP agent returned an invalid session id'); }
		this.sessionId = result.sessionId;
		this.availableModes = result.modes?.availableModes?.map(mode => mode.id) ?? [];
		await this.selectModel(result.models?.availableModels, signal);
		if (modeId) {
			if (!Array.isArray(result.modes?.availableModes) || !result.modes.availableModes.some(mode => mode.id === modeId)) { throw new Error(`ACP agent does not advertise the required mode: ${modeId}`); }
			await this.peer.request('session/set_mode', { sessionId: this.sessionId, modeId }, { signal });
		}
		return result.sessionId;
	}

	/** Load only a settled session. Replay notifications are deliberately not forwarded as live work. */
	async loadSession(sessionId: string, mcpServers: AcpMcpServer[] = [], signal?: AbortSignal, modeId?: string): Promise<void> {
		if (!this.initialization) { await this.initialize(signal); }
		if (!this.initialization?.agentCapabilities?.loadSession) { throw new Error('ACP adapter does not support loading sessions'); }
		if (this.sessionId) { throw new Error('ACP connection already owns a session'); }
		const result = await this.peer.request<{ modes?: { availableModes?: Array<{ id: string }> }; models?: { availableModels?: Array<{ modelId: string; name: string }> } }>('session/load', { sessionId, cwd: this.cwd, mcpServers }, { signal });
		this.sessionId = sessionId;
		this.availableModes = result?.modes?.availableModes?.map(mode => mode.id) ?? [];
		await this.selectModel(result?.models?.availableModels, signal);
		if (modeId) {
			if (!this.availableModes.includes(modeId)) { throw new Error(`ACP agent does not advertise the required mode: ${modeId}`); }
			await this.peer.request('session/set_mode', { sessionId, modeId }, { signal });
		}
	}

	private async selectModel(models: Array<{ modelId: string; name: string }> | undefined, signal?: AbortSignal): Promise<void> {
		this.modelsAdvertised = Array.isArray(models);
		this.modelsTruncated = false;
		this.availableModels = [];
		const exposed = new Set<string>();
		let selectedAdvertised = false;
		if (Array.isArray(models)) {
			for (const model of models) {
				if (!object(model) || !isValidAcpModelId(model.modelId) || typeof model.name !== 'string') { continue; }
				// Selection uses the complete validated advertisement. Only the
				// discovery/UI inventory and its deduplication set are capped.
				if (model.modelId === this.definition.modelId) { selectedAdvertised = true; }
				if (exposed.has(model.modelId)) { continue; }
				if (this.availableModels.length >= 500) { this.modelsTruncated = true; continue; }
				exposed.add(model.modelId);
				this.availableModels.push({ id: model.modelId, name: model.name.slice(0, 200) });
			}
		}
		if (this.definition.modelId) {
			if (!selectedAdvertised) { throw new Error('The ACP adapter does not advertise the selected model. Refresh its catalog or choose another model.'); }
			await this.peer.request('session/set_model', { sessionId: this.sessionId, modelId: this.definition.modelId }, { signal });
		}
	}

	async prompt(text: string, options: { images?: readonly AcpImage[]; signal: AbortSignal; update?: (update: AcpUpdate) => void; permission?: AcpPermissionHandler; timeoutMs?: number }): Promise<AcpPromptResult> {
		if (!this.sessionId) { throw new Error('ACP session has not been created'); }
		if (this.active) { throw new Error('ACP session already has an active prompt'); }
		options.signal.throwIfAborted();
		validateImages(options.images);
		if (options.images?.length && !this.initialization?.agentCapabilities?.promptCapabilities?.image) { throw new Error('This ACP adapter does not advertise image support. Select an image-capable adapter or remove the attachments.'); }
		this.active = options;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const cancel = () => {
			try { this.peer.notify('session/cancel', { sessionId: this.sessionId }); } catch { /* process already exited */ }
			// ACP cancellation completes through the prompt response. Kill an uncooperative process.
			killTimer = setTimeout(() => { void this.stop(); }, 2_000);
		};
		options.signal.addEventListener('abort', cancel, { once: true });
		try {
			const result = await this.peer.request<AcpPromptResult>('session/prompt', {
				sessionId: this.sessionId, prompt: [{ type: 'text', text }, ...(options.images ?? []).map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))],
			}, { timeoutMs: options.timeoutMs ?? 600_000 });
			if (options.signal.aborted) { throw abortError(); }
			if (!object(result) || !['end_turn', 'cancelled', 'refusal', 'max_tokens', 'max_turn_requests'].includes(result.stopReason)) { throw new Error('ACP agent returned an invalid stop reason'); }
			return result;
		} catch (error) {
			await this.stop();
			if (options.signal.aborted) { throw abortError(); }
			throw error;
		} finally {
			options.signal.removeEventListener('abort', cancel);
			if (killTimer) { clearTimeout(killTimer); }
			this.active = undefined;
		}
	}

	private stopAfterProcessExit(): Promise<void> {
		// Windows command shims can close stdio before cross-spawn reports ENOENT.
		// Give the process a bounded chance to report its real failure before killing it.
		return this.transportStopping ??= Promise.resolve().then(async () => {
			if (!this.exited) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([this.exitPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
				if (timer) { clearTimeout(timer); }
			}
			await this.stop();
		});
	}

	stop(): Promise<void> {
		if (this.stopping) { return this.stopping; }
		// Defer disposal so a peer's close callback cannot recursively enter stop.
		this.stopping = Promise.resolve().then(async () => {
			this.peer.dispose();
			this.child.stdin.destroy();
			const kill = (signal: NodeJS.Signals) => {
				try {
					if (process.platform !== 'win32' && this.child.pid) { process.kill(-this.child.pid, signal); }
					else { this.child.kill(signal); }
				} catch { /* exited */ }
			};
			if (process.platform === 'win32' && this.child.pid && !this.exited) {
				await new Promise<void>(resolve => execFile('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true }, () => resolve()));
			}
			kill('SIGTERM');
			if (!this.exited) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([this.exitPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
				if (timer) { clearTimeout(timer); }
			}
			// Also reap descendants that outlived the agent's own exit.
			kill('SIGKILL');
			this.child.stdout.destroy(); this.child.stderr.destroy();
		});
		return this.stopping;
	}

	private async handleRequest(method: string, params: unknown): Promise<unknown> {
		if (method !== 'session/request_permission') { throw new AcpError(-32601, `Unsupported client method: ${method}`); }
		if (!object(params) || params.sessionId !== this.sessionId || !object(params.toolCall) || typeof params.toolCall.toolCallId !== 'string' || !Array.isArray(params.options) || !params.options.every(option => object(option) && typeof option.optionId === 'string' && typeof option.name === 'string' && ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(String(option.kind)))) {
			throw new AcpError(-32602, 'Invalid ACP permission request');
		}
		const active = this.active;
		if (!active || active.signal.aborted || !active.permission) { return cancelledPermission(); }
		const request = params as unknown as AcpPermissionRequest;
		const permissionSignal = AbortSignal.any([active.signal, this.peer.signal]);
		let abort: (() => void) | undefined;
		try {
			const result = await Promise.race([
				active.permission(request, permissionSignal),
				new Promise<ReturnType<typeof cancelledPermission>>(resolve => { abort = () => resolve(cancelledPermission()); permissionSignal.addEventListener('abort', abort, { once: true }); if (permissionSignal.aborted) { abort(); } }),
			]);
			if (active.signal.aborted) { return cancelledPermission(); }
			if (result.outcome.outcome === 'selected' && !request.options.some(option => option.optionId === (result.outcome as { optionId: string }).optionId)) { throw new AcpError(-32602, 'Permission option was not offered by the agent'); }
			return result;
		} finally { if (abort) { permissionSignal.removeEventListener('abort', abort); } }
	}
}
