"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpConnection = void 0;
const node_child_process_1 = require("node:child_process");
const cross_spawn_1 = __importDefault(require("cross-spawn"));
const AcpPeer_1 = require("./AcpPeer");
const protocol_1 = require("./protocol");
/** One agent process and conversation. Never replays a prompt after a transport failure. */
class AcpConnection {
    definition;
    cwd;
    child;
    peer;
    sessionId;
    active;
    stopping;
    exited = false;
    exitPromise;
    spawned;
    initialization;
    availableModes = [];
    constructor(definition, cwd) {
        this.definition = definition;
        this.cwd = cwd;
        (0, protocol_1.validateAgent)(definition);
        this.child = (0, cross_spawn_1.default)(definition.command, definition.args ?? [], {
            cwd, env: { ...process.env, ...definition.env }, stdio: 'pipe', windowsHide: true,
            detached: process.platform !== 'win32',
        });
        this.peer = new AcpPeer_1.AcpPeer(this.child.stdout, this.child.stdin, {
            request: (method, params) => this.handleRequest(method, params),
            notification: (method, params) => {
                if (method === 'session/update' && (0, protocol_1.object)(params) && params.sessionId === this.sessionId && (0, protocol_1.object)(params.update) && typeof params.update.sessionUpdate === 'string') {
                    if (!this.active?.signal.aborted) {
                        this.active?.update?.(params.update);
                    }
                }
            },
            close: () => { void this.stop(); },
        });
        // Drain diagnostics without retaining unlimited logs or leaking provider credentials.
        this.child.stderr.resume();
        this.child.stdin.on('error', () => { });
        this.child.stdout.on('error', () => { });
        this.child.stderr.on('error', () => { });
        this.exitPromise = new Promise(resolve => {
            const exit = () => { this.exited = true; this.peer.dispose(new Error(`ACP agent ${definition.id} exited`)); resolve(); };
            this.child.once('exit', exit);
            this.child.once('error', exit);
        });
        this.spawned = new Promise((resolve, reject) => { this.child.once('spawn', resolve); this.child.once('error', reject); });
        // A spawn error may arrive before initialize is called.
        void this.spawned.catch(() => { });
    }
    get isConnected() { return this.peer.isConnected && !this.exited; }
    get remoteSessionId() { return this.sessionId; }
    async initialize(signal) {
        await this.spawned;
        const result = await this.peer.request('initialize', {
            protocolVersion: protocol_1.ACP_VERSION,
            clientInfo: { name: 'son-of-anton', version: '1.0.0' },
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        }, { signal });
        if (!(0, protocol_1.object)(result) || result.protocolVersion !== protocol_1.ACP_VERSION) {
            throw new Error(`ACP agent ${this.definition.id} did not negotiate protocol version ${protocol_1.ACP_VERSION}`);
        }
        this.initialization = result;
        if (this.definition.authMethodId) {
            if (!result.authMethods?.some(method => method.id === this.definition.authMethodId)) {
                throw new Error('Configured ACP authentication method is not advertised by the agent');
            }
            await this.peer.request('authenticate', { methodId: this.definition.authMethodId }, { signal });
        }
        return result;
    }
    async newSession(mcpServers = [], signal, modeId) {
        if (!this.initialization) {
            await this.initialize(signal);
        }
        if (this.sessionId) {
            throw new Error('ACP connection already owns a session');
        }
        const result = await this.peer.request('session/new', { cwd: this.cwd, mcpServers }, { signal });
        if (!(0, protocol_1.object)(result) || typeof result.sessionId !== 'string' || !result.sessionId) {
            throw new Error('ACP agent returned an invalid session id');
        }
        this.sessionId = result.sessionId;
        this.availableModes = result.modes?.availableModes?.map(mode => mode.id) ?? [];
        if (modeId) {
            if (!Array.isArray(result.modes?.availableModes) || !result.modes.availableModes.some(mode => mode.id === modeId)) {
                throw new Error(`ACP agent does not advertise the required mode: ${modeId}`);
            }
            await this.peer.request('session/set_mode', { sessionId: this.sessionId, modeId }, { signal });
        }
        return result.sessionId;
    }
    async prompt(text, options) {
        if (!this.sessionId) {
            throw new Error('ACP session has not been created');
        }
        if (this.active) {
            throw new Error('ACP session already has an active prompt');
        }
        options.signal.throwIfAborted();
        this.active = options;
        let killTimer;
        const cancel = () => {
            try {
                this.peer.notify('session/cancel', { sessionId: this.sessionId });
            }
            catch { /* process already exited */ }
            // ACP cancellation completes through the prompt response. Kill an uncooperative process.
            killTimer = setTimeout(() => { void this.stop(); }, 2_000);
        };
        options.signal.addEventListener('abort', cancel, { once: true });
        try {
            const result = await this.peer.request('session/prompt', {
                sessionId: this.sessionId, prompt: [{ type: 'text', text }],
            }, { timeoutMs: options.timeoutMs ?? 600_000 });
            if (options.signal.aborted) {
                throw (0, protocol_1.abortError)();
            }
            if (!(0, protocol_1.object)(result) || !['end_turn', 'cancelled', 'refusal', 'max_tokens', 'max_turn_requests'].includes(result.stopReason)) {
                throw new Error('ACP agent returned an invalid stop reason');
            }
            return result;
        }
        catch (error) {
            await this.stop();
            if (options.signal.aborted) {
                throw (0, protocol_1.abortError)();
            }
            throw error;
        }
        finally {
            options.signal.removeEventListener('abort', cancel);
            if (killTimer) {
                clearTimeout(killTimer);
            }
            this.active = undefined;
        }
    }
    stop() {
        if (this.stopping) {
            return this.stopping;
        }
        // Defer disposal so a peer's close callback cannot recursively enter stop.
        this.stopping = Promise.resolve().then(async () => {
            this.peer.dispose();
            this.child.stdin.destroy();
            const kill = (signal) => {
                try {
                    if (process.platform !== 'win32' && this.child.pid) {
                        process.kill(-this.child.pid, signal);
                    }
                    else {
                        this.child.kill(signal);
                    }
                }
                catch { /* exited */ }
            };
            if (process.platform === 'win32' && this.child.pid && !this.exited) {
                await new Promise(resolve => (0, node_child_process_1.execFile)('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true }, () => resolve()));
            }
            kill('SIGTERM');
            if (!this.exited) {
                let timer;
                await Promise.race([this.exitPromise, new Promise(resolve => { timer = setTimeout(resolve, 1_000); })]);
                if (timer) {
                    clearTimeout(timer);
                }
            }
            // Also reap descendants that outlived the agent's own exit.
            kill('SIGKILL');
            this.child.stdout.destroy();
            this.child.stderr.destroy();
        });
        return this.stopping;
    }
    async handleRequest(method, params) {
        if (method !== 'session/request_permission') {
            throw new protocol_1.AcpError(-32601, `Unsupported client method: ${method}`);
        }
        if (!(0, protocol_1.object)(params) || params.sessionId !== this.sessionId || !(0, protocol_1.object)(params.toolCall) || typeof params.toolCall.toolCallId !== 'string' || !Array.isArray(params.options) || !params.options.every(option => (0, protocol_1.object)(option) && typeof option.optionId === 'string' && typeof option.name === 'string' && ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(String(option.kind)))) {
            throw new protocol_1.AcpError(-32602, 'Invalid ACP permission request');
        }
        const active = this.active;
        if (!active || active.signal.aborted || !active.permission) {
            return (0, protocol_1.cancelledPermission)();
        }
        const request = params;
        const permissionSignal = AbortSignal.any([active.signal, this.peer.signal]);
        let abort;
        try {
            const result = await Promise.race([
                active.permission(request, permissionSignal),
                new Promise(resolve => { abort = () => resolve((0, protocol_1.cancelledPermission)()); permissionSignal.addEventListener('abort', abort, { once: true }); if (permissionSignal.aborted) {
                    abort();
                } }),
            ]);
            if (active.signal.aborted) {
                return (0, protocol_1.cancelledPermission)();
            }
            if (result.outcome.outcome === 'selected' && !request.options.some(option => option.optionId === result.outcome.optionId)) {
                throw new protocol_1.AcpError(-32602, 'Permission option was not offered by the agent');
            }
            return result;
        }
        finally {
            if (abort) {
                permissionSignal.removeEventListener('abort', abort);
            }
        }
    }
}
exports.AcpConnection = AcpConnection;
//# sourceMappingURL=AcpConnection.js.map