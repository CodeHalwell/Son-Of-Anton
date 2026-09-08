"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpRuntime = void 0;
const node_crypto_1 = require("node:crypto");
const node_path_1 = require("node:path");
const AcpConnection_1 = require("./AcpConnection");
const protocol_1 = require("./protocol");
/** Shared process budget, fair bounded queue, conversation isolation and idle process reuse. */
class AcpRuntime {
    workers = new Map();
    queue = [];
    active = new Set();
    reaper;
    disposed = false;
    pumping = false;
    stopping = new Set();
    completed = 0;
    failed = 0;
    reused = 0;
    maxProcesses;
    maxQueue;
    idleTimeoutMs;
    constructor(options = {}) {
        this.maxProcesses = bounded(options.maxProcesses, 4, 1, 32);
        this.maxQueue = bounded(options.maxQueue, 32, 1, 256);
        this.idleTimeoutMs = bounded(options.idleTimeoutMs, 300_000, 1_000, 3_600_000);
        this.reaper = setInterval(() => {
            for (const worker of this.workers.values()) {
                if (!worker.busy && Date.now() - worker.lastUsed >= this.idleTimeoutMs) {
                    this.retire(worker);
                }
            }
        }, Math.min(this.idleTimeoutMs, 30_000));
        this.reaper.unref();
    }
    run(turn) {
        if (this.disposed) {
            return Promise.reject(new Error('ACP runtime is shut down'));
        }
        if (turn.signal?.aborted) {
            return Promise.reject((0, protocol_1.abortError)());
        }
        if (!(0, node_path_1.isAbsolute)(turn.cwd) || !turn.conversationId || !turn.text.trim()) {
            return Promise.reject(new Error('ACP turn requires an absolute cwd, conversation id and text'));
        }
        if (this.queue.length >= this.maxQueue) {
            return Promise.reject(new Error('ACP request queue is full'));
        }
        const key = this.key(turn);
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            let done = false;
            let remaining = bounded(turn.timeoutMs, 300_000, 1, 3_600_000);
            let started = Date.now(), permissionDepth = 0;
            let permissionTimeout;
            let timeout;
            const arm = () => { started = Date.now(); timeout = setTimeout(() => controller.abort(new Error('ACP turn deadline exceeded')), remaining); };
            arm();
            const permission = turn.onPermission && (async (request, signal) => {
                if (permissionDepth++ === 0) {
                    clearTimeout(timeout);
                    remaining = Math.max(1, remaining - (Date.now() - started));
                    permissionTimeout = setTimeout(() => controller.abort(new Error('ACP permission request timed out')), 600_000);
                }
                try {
                    return await turn.onPermission(request, signal);
                }
                finally {
                    if (--permissionDepth === 0) {
                        clearTimeout(permissionTimeout);
                        if (!done && !controller.signal.aborted) {
                            arm();
                        }
                    }
                }
            });
            const externalAbort = () => controller.abort((0, protocol_1.abortError)());
            const job = {
                key, turn: { ...turn, onPermission: permission }, controller,
                finish: (error, result) => {
                    if (done) {
                        return;
                    }
                    done = true;
                    clearTimeout(timeout);
                    clearTimeout(permissionTimeout);
                    turn.signal?.removeEventListener('abort', externalAbort);
                    controller.signal.removeEventListener('abort', job.abort);
                    if (error) {
                        this.failed++;
                        reject(error);
                    }
                    else {
                        this.completed++;
                        resolve(result);
                    }
                },
                abort: () => {
                    const index = this.queue.indexOf(job);
                    if (index !== -1) {
                        this.queue.splice(index, 1);
                        job.finish(controller.signal.reason);
                    }
                },
            };
            turn.signal?.addEventListener('abort', externalAbort, { once: true });
            controller.signal.addEventListener('abort', job.abort, { once: true });
            this.queue.push(job);
            void this.pump();
        });
    }
    snapshot() {
        return { processes: this.workers.size, active: this.active.size, queued: this.queue.length, completed: this.completed, failed: this.failed, reused: this.reused, maxProcesses: this.maxProcesses };
    }
    /** Release one host conversation, including requests waiting for a process slot. */
    async release(conversationId) {
        for (const job of [...this.queue, ...this.active]) {
            if (job.turn.conversationId === conversationId) {
                job.controller.abort((0, protocol_1.abortError)());
            }
        }
        for (const worker of this.workers.values()) {
            if (JSON.parse(worker.key)[0] === conversationId) {
                this.retire(worker);
            }
        }
        await Promise.allSettled(this.stopping);
    }
    async shutdown() {
        if (this.disposed) {
            await Promise.allSettled(this.stopping);
            return;
        }
        this.disposed = true;
        clearInterval(this.reaper);
        for (const job of [...this.queue, ...this.active]) {
            job.controller.abort((0, protocol_1.abortError)());
        }
        for (const worker of this.workers.values()) {
            this.retire(worker);
        }
        await Promise.allSettled(this.stopping);
    }
    key(turn) {
        // Hash invocation configuration: environment secrets must not appear in diagnostics or keys.
        const fingerprint = (0, node_crypto_1.createHash)('sha256').update(JSON.stringify([turn.agent, turn.mcpServers ?? [], turn.modeId])).digest('hex');
        return JSON.stringify([turn.conversationId, turn.cwd, fingerprint]);
    }
    retire(worker) {
        if (this.workers.get(worker.key) === worker) {
            this.workers.delete(worker.key);
        }
        const stop = worker.connection.stop();
        this.stopping.add(stop);
        void stop.finally(() => { this.stopping.delete(stop); void this.pump(); });
    }
    async pump() {
        if (this.pumping || this.disposed) {
            return;
        }
        this.pumping = true;
        try {
            while (this.queue.length && !this.disposed) {
                // A busy conversation must not block unrelated work behind it.
                const index = this.queue.findIndex(job => !this.workers.get(job.key)?.busy);
                if (index === -1) {
                    break;
                }
                const job = this.queue[index];
                let worker = this.workers.get(job.key);
                if (worker && !worker.connection.isConnected) {
                    this.retire(worker);
                    worker = undefined;
                }
                if (!worker && this.workers.size + this.stopping.size >= this.maxProcesses) {
                    const idle = [...this.workers.values()].filter(item => !item.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
                    if (!idle) {
                        break;
                    }
                    this.retire(idle);
                    await Promise.allSettled(this.stopping);
                    continue;
                }
                this.queue.splice(index, 1);
                if (job.controller.signal.aborted) {
                    job.finish(job.controller.signal.reason);
                    continue;
                }
                if (!worker) {
                    try {
                        worker = { key: job.key, connection: new AcpConnection_1.AcpConnection(job.turn.agent, job.turn.cwd), busy: false, lastUsed: Date.now(), ready: false };
                    }
                    catch (error) {
                        job.finish(error);
                        continue;
                    }
                    this.workers.set(job.key, worker);
                }
                else {
                    this.reused++;
                }
                worker.busy = true;
                this.active.add(job);
                void this.execute(worker, job);
            }
        }
        finally {
            this.pumping = false;
        }
    }
    async execute(worker, job) {
        try {
            const fresh = !worker.ready;
            if (fresh) {
                await worker.connection.newSession(job.turn.mcpServers, job.controller.signal, job.turn.modeId);
                worker.ready = true;
            }
            const text = fresh && job.turn.initialContext ? `${job.turn.initialContext}\n\n${job.turn.text}` : job.turn.text;
            const result = await worker.connection.prompt(text, { signal: job.controller.signal, update: job.turn.onUpdate, permission: job.turn.onPermission, timeoutMs: 3_600_000 });
            job.finish(undefined, result);
        }
        catch (error) {
            this.retire(worker);
            job.finish(job.controller.signal.aborted ? job.controller.signal.reason : error);
        }
        finally {
            worker.busy = false;
            worker.lastUsed = Date.now();
            this.active.delete(job);
            void this.pump();
        }
    }
}
exports.AcpRuntime = AcpRuntime;
function bounded(value, fallback, min, max) {
    return value !== undefined && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
//# sourceMappingURL=AcpRuntime.js.map