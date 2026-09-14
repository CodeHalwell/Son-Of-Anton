"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpPeer = void 0;
const node_string_decoder_1 = require("node:string_decoder");
const protocol_1 = require("./protocol");
/** Bidirectional, bounded newline JSON-RPC. Incoming requests and responses have separate namespaces. */
class AcpPeer {
    input;
    output;
    handlers;
    maxFrameBytes;
    decoder = new node_string_decoder_1.StringDecoder('utf8');
    buffer = '';
    bufferedBytes = 0;
    queuedBytes = 0;
    nextId = 0;
    pending = new Map();
    incoming = new Set();
    closed = false;
    closedController = new AbortController();
    signal = this.closedController.signal;
    constructor(input, output, handlers = {}, maxFrameBytes = 4 * 1024 * 1024) {
        this.input = input;
        this.output = output;
        this.handlers = handlers;
        this.maxFrameBytes = maxFrameBytes;
        input.on('data', this.onData);
        input.on('end', this.onEnd);
        input.on('error', this.onError);
        output.on('error', this.onError);
        output.on('close', this.onEnd);
    }
    get isConnected() { return !this.closed; }
    get pendingCount() { return this.pending.size; }
    request(method, params, options = {}) {
        if (this.closed) {
            return Promise.reject(new Error('ACP connection is closed'));
        }
        if (options.signal?.aborted) {
            return Promise.reject((0, protocol_1.abortError)());
        }
        if (this.pending.size >= 128) {
            return Promise.reject(new Error('ACP pending request limit reached'));
        }
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const finish = (error) => { const pending = this.pending.get(id); if (pending) {
                this.pending.delete(id);
                pending.cleanup();
                reject(error);
            } };
            const abort = () => finish((0, protocol_1.abortError)());
            const timer = setTimeout(() => finish(new protocol_1.AcpError(-32003, `ACP ${method} timed out`)), options.timeoutMs ?? 30_000);
            const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
            this.pending.set(id, { resolve: value => resolve(value), reject, cleanup });
            options.signal?.addEventListener('abort', abort, { once: true });
            try {
                this.write({ jsonrpc: '2.0', id, method, params });
            }
            catch (error) {
                finish(error);
            }
        });
    }
    notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
    dispose(error = new Error('ACP connection closed')) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.closedController.abort();
        this.input.off('data', this.onData);
        this.input.off('end', this.onEnd);
        this.input.off('error', this.onError);
        this.output.off('error', this.onError);
        this.output.off('close', this.onEnd);
        for (const pending of this.pending.values()) {
            pending.cleanup();
            pending.reject(error);
        }
        this.pending.clear();
        this.buffer = '';
        this.handlers.close?.(error);
    }
    onError = (error) => this.dispose(error);
    onEnd = () => this.dispose(new Error(this.buffer ? 'ACP stream ended with an incomplete frame' : 'ACP stream closed'));
    onData = (chunk) => {
        if (this.closed) {
            return;
        }
        const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
        // Scan only the new chunk, avoiding repeated splitting of a growing incomplete frame.
        let offset = 0;
        while (offset < decoded.length && !this.closed) {
            const newline = decoded.indexOf('\n', offset);
            const part = decoded.slice(offset, newline === -1 ? undefined : newline);
            this.bufferedBytes += Buffer.byteLength(part);
            if (this.bufferedBytes > this.maxFrameBytes) {
                this.dispose(new Error('ACP frame exceeds byte limit'));
                return;
            }
            this.buffer += part;
            if (newline === -1) {
                break;
            }
            const line = this.buffer.trim();
            this.buffer = '';
            this.bufferedBytes = 0;
            if (line) {
                this.receive(line);
            }
            offset = newline + 1;
        }
    };
    write(message) {
        if (this.closed) {
            throw new Error('ACP connection is closed');
        }
        const frame = JSON.stringify(message) + '\n';
        const bytes = Buffer.byteLength(frame);
        if (bytes > this.maxFrameBytes || this.queuedBytes + bytes > this.maxFrameBytes * 2) {
            const error = new Error('ACP output backpressure limit reached');
            this.dispose(error);
            throw error;
        }
        this.queuedBytes += bytes;
        this.output.write(frame, error => { this.queuedBytes -= bytes; if (error) {
            this.dispose(error);
        } });
    }
    receive(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            this.replyError(null, new protocol_1.AcpError(-32700, 'Invalid JSON'));
            return;
        }
        if (!(0, protocol_1.object)(message) || message.jsonrpc !== '2.0') {
            this.replyError(null, new protocol_1.AcpError(-32600, 'Invalid JSON-RPC envelope'));
            return;
        }
        const id = message.id;
        const hasId = Object.hasOwn(message, 'id');
        if (typeof message.method === 'string') {
            if (!hasId) {
                try {
                    this.handlers.notification?.(message.method, message.params);
                }
                catch (error) {
                    this.dispose(error);
                }
                return;
            }
            if (typeof id !== 'string' && typeof id !== 'number') {
                this.replyError(null, new protocol_1.AcpError(-32600, 'Invalid request id'));
                return;
            }
            if (this.incoming.has(id) || this.incoming.size >= 128) {
                this.replyError(id, new protocol_1.AcpError(-32600, 'Duplicate request id or incoming request limit reached'));
                return;
            }
            this.incoming.add(id);
            const method = message.method;
            void Promise.resolve().then(() => {
                if (!this.handlers.request) {
                    throw new protocol_1.AcpError(-32601, `Unsupported method: ${method}`);
                }
                return this.handlers.request(method, message.params);
            }).then(result => {
                if (!this.closed) {
                    this.write({ jsonrpc: '2.0', id, result: result ?? null });
                }
            }, error => this.replyError(id, error instanceof protocol_1.AcpError ? error : new protocol_1.AcpError(-32603, error instanceof Error ? error.message : 'ACP handler failed')))
                .catch(error => this.dispose(error)).finally(() => this.incoming.delete(id));
            return;
        }
        if (typeof id !== 'string' && typeof id !== 'number') {
            return;
        }
        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }
        this.pending.delete(id);
        pending.cleanup();
        if ((0, protocol_1.object)(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') {
            pending.reject(new protocol_1.AcpError(message.error.code, message.error.message, message.error.data));
        }
        else if (Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) {
            pending.resolve(message.result);
        }
        else {
            pending.reject(new Error('Invalid ACP response'));
        }
    }
    replyError(id, error) {
        if (!this.closed) {
            try {
                this.write({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message, data: error.data } });
            }
            catch { /* write closes on overflow */ }
        }
    }
}
exports.AcpPeer = AcpPeer;
//# sourceMappingURL=AcpPeer.js.map