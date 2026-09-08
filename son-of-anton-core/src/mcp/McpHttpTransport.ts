/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { JsonRpcMessage } from './McpStdioTransport';

/** Official SDK framing/session handling for remotely configured MCP servers. */
export class McpHttpTransport {
	private readonly transport: StreamableHTTPClientTransport | SSEClientTransport;
	private errorHandler?: (error: Error) => void;
	private disposed = false;
	constructor(options: { url: string; headers?: Record<string, string>; transport?: 'http' | 'sse' }) {
		const url = new URL(options.url);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) { throw new Error('MCP endpoint must be an HTTP URL without embedded credentials'); }
		const requestInit = { headers: options.headers, redirect: 'error' as const };
		this.transport = options.transport === 'sse' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
		this.transport.onerror = error => this.errorHandler?.(error);
	}
	async start(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([this.transport.start(), new Promise<never>((_, reject) => {
				timer = setTimeout(() => { this.dispose(); reject(new Error('MCP HTTP connection timed out')); }, 10_000);
			})]);
		} finally { if (timer) { clearTimeout(timer); } }
	}
	setProtocolVersion(version: string): void {
		if (this.transport instanceof StreamableHTTPClientTransport) { this.transport.setProtocolVersion(version); }
	}
	async send(message: object): Promise<void> {
		if (this.disposed) { throw new Error('MCP transport is disposed'); }
		await this.transport.send(message as JSONRPCMessage);
	}
	onMessage(handler: (message: JsonRpcMessage) => void): void { this.transport.onmessage = message => handler(message as JsonRpcMessage); }
	onClose(handler: (code: number | null) => void): void { this.transport.onclose = () => handler(null); }
	onError(handler: (error: Error) => void): void { this.errorHandler = handler; }
	dispose(): void { if (!this.disposed) { this.disposed = true; void this.transport.close().catch(() => { /* Best-effort shutdown. */ }); } }
}
