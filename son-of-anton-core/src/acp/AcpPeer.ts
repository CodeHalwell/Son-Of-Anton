/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { AcpError, abortError, object } from './protocol';

type Id = string | number;
interface Pending { resolve(value: unknown): void; reject(error: Error): void; cleanup(): void }
export interface AcpPeerHandlers {
	request?(method: string, params: unknown): Promise<unknown>;
	notification?(method: string, params: unknown): void;
	close?(error: Error): void;
}

/** Bidirectional, bounded newline JSON-RPC. Incoming requests and responses have separate namespaces. */
export class AcpPeer {
	private readonly decoder = new StringDecoder('utf8');
	private buffer = '';
	private bufferedBytes = 0;
	private queuedBytes = 0;
	private nextId = 0;
	private readonly pending = new Map<Id, Pending>();
	private readonly incoming = new Set<Id>();
	private closed = false;
	private readonly closedController = new AbortController();
	readonly signal = this.closedController.signal;

	constructor(private readonly input: Readable, private readonly output: Writable, private readonly handlers: AcpPeerHandlers = {}, private readonly maxFrameBytes = 4 * 1024 * 1024) {
		input.on('data', this.onData);
		input.on('end', this.onEnd);
		input.on('error', this.onError);
		output.on('error', this.onError);
		output.on('close', this.onEnd);
	}

	get isConnected(): boolean { return !this.closed; }
	get pendingCount(): number { return this.pending.size; }

	request<T>(method: string, params?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
		if (this.closed) { return Promise.reject(new Error('ACP connection is closed')); }
		if (options.signal?.aborted) { return Promise.reject(abortError()); }
		if (this.pending.size >= 128) { return Promise.reject(new Error('ACP pending request limit reached')); }
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			const finish = (error: Error) => { const pending = this.pending.get(id); if (pending) { this.pending.delete(id); pending.cleanup(); reject(error); } };
			const abort = () => finish(abortError());
			const timer = setTimeout(() => finish(new AcpError(-32003, `ACP ${method} timed out`)), options.timeoutMs ?? 30_000);
			const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
			this.pending.set(id, { resolve: value => resolve(value as T), reject, cleanup });
			options.signal?.addEventListener('abort', abort, { once: true });
			try { this.write({ jsonrpc: '2.0', id, method, params }); } catch (error) { finish(error as Error); }
		});
	}

	notify(method: string, params?: unknown): void { this.write({ jsonrpc: '2.0', method, params }); }

	dispose(error = new Error('ACP connection closed')): void {
		if (this.closed) { return; }
		this.closed = true;
		this.closedController.abort();
		this.input.off('data', this.onData);
		this.input.off('end', this.onEnd);
		this.input.off('error', this.onError);
		this.output.off('error', this.onError);
		this.output.off('close', this.onEnd);
		for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error); }
		this.pending.clear();
		this.buffer = '';
		this.handlers.close?.(error);
	}

	private readonly onError = (error: Error) => this.dispose(error);
	private readonly onEnd = () => this.dispose(new Error(this.buffer ? 'ACP stream ended with an incomplete frame' : 'ACP stream closed'));
	private readonly onData = (chunk: Buffer | string) => {
		if (this.closed) { return; }
		const decoded = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
		// Scan only the new chunk, avoiding repeated splitting of a growing incomplete frame.
		let offset = 0;
		while (offset < decoded.length && !this.closed) {
			const newline = decoded.indexOf('\n', offset);
			const part = decoded.slice(offset, newline === -1 ? undefined : newline);
			this.bufferedBytes += Buffer.byteLength(part);
			if (this.bufferedBytes > this.maxFrameBytes) { this.dispose(new Error('ACP frame exceeds byte limit')); return; }
			this.buffer += part;
			if (newline === -1) { break; }
			const line = this.buffer.trim();
			this.buffer = ''; this.bufferedBytes = 0;
			if (line) { this.receive(line); }
			offset = newline + 1;
		}
	};

	private write(message: object): void {
		if (this.closed) { throw new Error('ACP connection is closed'); }
		const frame = JSON.stringify(message) + '\n';
		const bytes = Buffer.byteLength(frame);
		if (bytes > this.maxFrameBytes || this.queuedBytes + bytes > this.maxFrameBytes * 2) {
			const error = new Error('ACP output backpressure limit reached');
			this.dispose(error); throw error;
		}
		this.queuedBytes += bytes;
		this.output.write(frame, error => { this.queuedBytes -= bytes; if (error) { this.dispose(error); } });
	}

	private receive(line: string): void {
		let message: unknown;
		try { message = JSON.parse(line); } catch { this.replyError(null, new AcpError(-32700, 'Invalid JSON')); return; }
		if (!object(message) || message.jsonrpc !== '2.0') { this.replyError(null, new AcpError(-32600, 'Invalid JSON-RPC envelope')); return; }
		const id = message.id;
		const hasId = Object.hasOwn(message, 'id');
		if (typeof message.method === 'string') {
			if (!hasId) {
				try { this.handlers.notification?.(message.method, message.params); } catch (error) { this.dispose(error as Error); }
				return;
			}
			if (typeof id !== 'string' && typeof id !== 'number') { this.replyError(null, new AcpError(-32600, 'Invalid request id')); return; }
			if (this.incoming.has(id) || this.incoming.size >= 128) { this.replyError(id, new AcpError(-32600, 'Duplicate request id or incoming request limit reached')); return; }
			this.incoming.add(id);
			const method = message.method;
			void Promise.resolve().then(() => {
				if (!this.handlers.request) { throw new AcpError(-32601, `Unsupported method: ${method}`); }
				return this.handlers.request(method, message.params);
			}).then(result => {
				if (!this.closed) { this.write({ jsonrpc: '2.0', id, result: result ?? null }); }
			}, error => this.replyError(id, error instanceof AcpError ? error : new AcpError(-32603, error instanceof Error ? error.message : 'ACP handler failed')))
				.catch(error => this.dispose(error as Error)).finally(() => this.incoming.delete(id));
			return;
		}
		if (typeof id !== 'string' && typeof id !== 'number') { return; }
		const pending = this.pending.get(id);
		if (!pending) { return; }
		this.pending.delete(id); pending.cleanup();
		if (object(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') {
			pending.reject(new AcpError(message.error.code, message.error.message, message.error.data));
		} else if (Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) { pending.resolve(message.result); }
		else { pending.reject(new Error('Invalid ACP response')); }
	}

	private replyError(id: Id | null, error: AcpError): void {
		if (!this.closed) { try { this.write({ jsonrpc: '2.0', id, error: { code: error.code, message: error.message, data: error.data } }); } catch { /* write closes on overflow */ } }
	}
}
