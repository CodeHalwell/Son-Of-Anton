/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import {
	JsonRpcId,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
} from './McpStdioTransport';

export interface McpTransport {
	start(): void | Promise<void>;
	send(message: object): void | Promise<void>;
	onMessage(handler: (message: JsonRpcMessage) => void): void;
	onClose(handler: (code: number | null) => void): void;
	onError(handler: (error: Error) => void): void;
	dispose(): void;
	setProtocolVersion?(version: string): void;
}

const INITIALIZE_TIMEOUT_MS = 10_000;
const TOOL_CALL_TIMEOUT_MS = 30_000;
const PROTOCOL_VERSION = '2024-11-05';

/**
 * Behavioural hints a server may attach to a tool via the MCP `annotations`
 * field (spec: `ToolAnnotations`). All are advisory and untrusted — a server
 * can lie — but they're the only signal we have about whether a tool is a
 * read or a destructive write, so the bridge uses them (conservatively) to
 * derive an approval `riskLevel`. Absent server support, every field is
 * `undefined` and the tool is treated as requiring approval.
 */
export interface McpToolAnnotations {
	readonly title?: string;
	/** `true` if the tool does not modify its environment (read-only). */
	readonly readOnlyHint?: boolean;
	/** `true` if the tool may perform destructive updates. Only meaningful when `readOnlyHint` is not `true`. */
	readonly destructiveHint?: boolean;
	/** `true` if repeated calls with the same arguments have no additional effect. */
	readonly idempotentHint?: boolean;
	/** `true` if the tool interacts with an open, external world (e.g. the web). */
	readonly openWorldHint?: boolean;
}

export interface McpToolDescriptor {
	name: string;
	description: string;
	inputSchema?: object;
	/** Server-declared behavioural hints, when present. See {@link McpToolAnnotations}. */
	annotations?: McpToolAnnotations;
}

export interface McpToolCallResult {
	content: string;
	isError: boolean;
}

export type McpServerState = 'idle' | 'connecting' | 'ready' | 'error' | 'closed';

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	cleanup: () => void;
}

interface McpToolsListResult {
	tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown }>;
}

interface McpToolCallContentPart {
	type?: string;
	text?: string;
}

interface McpToolCallRawResult {
	content?: McpToolCallContentPart[];
	isError?: boolean;
}

export interface McpServerConnectionOptions {
	name: string;
	transport: McpTransport;
	onStateChange?: (state: McpServerState, error?: string) => void;
	onToolsChanged?: () => void;
}

export class McpServerConnection {
	readonly name: string;
	private readonly transport: McpTransport;
	private readonly pending = new Map<JsonRpcId, PendingRequest>();
	private nextId = 1;
	private currentState: McpServerState = 'idle';
	private currentError: Error | undefined;
	private cachedTools: McpToolDescriptor[] | undefined;

	constructor(private readonly options: McpServerConnectionOptions) {
		this.name = options.name;
		this.transport = options.transport;
	}

	private setState(state: McpServerState): void {
		this.currentState = state;
		this.options.onStateChange?.(state, this.currentError?.message);
	}

	get state(): McpServerState {
		return this.currentState;
	}

	get lastError(): Error | undefined {
		return this.currentError;
	}

	async connect(): Promise<void> {
		if (this.currentState === 'ready' || this.currentState === 'connecting') {
			return;
		}
		this.setState('connecting');
		this.transport.onMessage(msg => this.handleMessage(msg));
		this.transport.onClose(code => this.handleClose(code));
		this.transport.onError(err => this.handleError(err));

		try {
			await this.transport.start();
		} catch (err) {
			const wrapped = err instanceof Error ? err : new Error(String(err));
			this.currentError = wrapped;
			this.setState('error');
			throw wrapped;
		}

		try {
			const initialized = await this.request(
				'initialize',
				{
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: 'son-of-anton', version: '0.1.0' },
				},
				INITIALIZE_TIMEOUT_MS,
			);
			const protocolVersion = initialized && typeof initialized === 'object' && 'protocolVersion' in initialized ? initialized.protocolVersion : undefined;
			if (typeof protocolVersion === 'string') { this.transport.setProtocolVersion?.(protocolVersion); }
			await this.transport.send({
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			});
			if (this.currentState === 'closed') { throw new Error('MCP connection disposed during initialization'); }
			this.setState('ready');
		} catch (err) {
			const wrapped = err instanceof Error ? err : new Error(String(err));
			this.currentError = wrapped;
			if (this.currentState !== 'closed') { this.setState('error'); }
			this.failPending(wrapped);
			throw wrapped;
		}
	}

	/** Send a host notification without creating a pending request. */
	async notify(method: string, params: Record<string, unknown>): Promise<void> {
		this.ensureReady();
		await this.transport.send({ jsonrpc: '2.0', method, params });
	}

	async listTools(refresh = false): Promise<McpToolDescriptor[]> {
		if (this.cachedTools && !refresh) {
			return this.cachedTools;
		}
		this.ensureReady();
		const raw = await this.request('tools/list', {}, TOOL_CALL_TIMEOUT_MS);
		const result = (raw ?? {}) as McpToolsListResult;
		const tools = Array.isArray(result.tools) ? result.tools : [];
		const normalised: McpToolDescriptor[] = [];
		for (const t of tools) {
			if (typeof t?.name !== 'string') {
				continue;
			}
			normalised.push({
				name: t.name,
				description: typeof t.description === 'string' ? t.description : '',
				inputSchema: typeof t.inputSchema === 'object' && t.inputSchema !== null
					? t.inputSchema as object
					: undefined,
				annotations: parseToolAnnotations(t.annotations),
			});
		}
		this.cachedTools = normalised;
		return normalised;
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult> {
		this.ensureReady();
		const raw = await this.request(
			'tools/call',
			{ name, arguments: args },
			TOOL_CALL_TIMEOUT_MS,
			signal,
		);
		const result = (raw ?? {}) as McpToolCallRawResult;
		const parts = Array.isArray(result.content) ? result.content : [];
		const text = parts
			.filter(p => p?.type === 'text' && typeof p.text === 'string')
			.map(p => p.text as string)
			.join('');
		return {
			content: text,
			isError: result.isError === true,
		};
	}

	dispose(): void {
		if (this.currentState === 'closed') {
			return;
		}
		this.currentState = 'closed';
		this.failPending(new Error(`MCP server '${this.name}' connection disposed`));
		this.transport.dispose();
	}

	private ensureReady(): void {
		if (this.currentState !== 'ready') {
			throw new Error(`MCP server '${this.name}' is not connected (state=${this.currentState})`);
		}
	}

	private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
		if (signal?.aborted) { return Promise.reject(new Error('MCP request cancelled')); }
		return new Promise<unknown>((resolve, reject) => {
			const id = this.nextId++;
			const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
			const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
			const abort = () => {
				if (!this.pending.delete(id)) { return; }
				cleanup();
				try { void Promise.resolve(this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Client cancelled the turn' } })).catch(() => {}); } catch { /* connection closed */ }
				reject(new Error('MCP request cancelled'));
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				cleanup();
				reject(new Error(`MCP request '${method}' to '${this.name}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, cleanup });
			signal?.addEventListener('abort', abort, { once: true });
			const sendFailed = (err: unknown) => {
				if (!this.pending.delete(id)) { return; }
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			};
			try { void Promise.resolve(this.transport.send(message)).catch(sendFailed); } catch (err) { sendFailed(err); }
		});
	}

	private handleMessage(msg: JsonRpcMessage): void {
		const id = (msg as { id?: JsonRpcId }).id;
		if (id === undefined || id === null) {
			if ('method' in msg && msg.method === 'notifications/tools/list_changed') { this.cachedTools = undefined; this.options.onToolsChanged?.(); }
			return;
		}
		const pending = this.pending.get(id);
		if (!pending) {
			return;
		}
		this.pending.delete(id);
		pending.cleanup();
		const response = msg as JsonRpcResponse;
		if (response.error) {
			pending.reject(new Error(`MCP error from '${this.name}': ${response.error.message}`));
			return;
		}
		pending.resolve(response.result);
	}

	private handleClose(code: number | null): void {
		if (this.currentState === 'closed') {
			return;
		}
		this.setState('closed');
		const err = new Error(`MCP server '${this.name}' exited with code ${code ?? 'null'}`);
		this.currentError = err;
		this.failPending(err);
	}

	private handleError(err: Error): void {
		this.currentError = err;
		if (this.currentState === 'connecting' || this.currentState === 'ready') {
			this.setState('error');
		}
		this.failPending(err);
	}

	private failPending(err: Error): void {
		for (const [, pending] of this.pending) {
			pending.cleanup();
			pending.reject(err);
		}
		this.pending.clear();
	}
}

/**
 * Coerce a raw MCP `annotations` payload into {@link McpToolAnnotations},
 * keeping only recognised boolean hints (and the optional title). Returns
 * `undefined` when the payload is absent or carries no recognised field, so
 * downstream risk derivation can cleanly distinguish "no hints" from
 * "explicitly read-only".
 */
function parseToolAnnotations(raw: unknown): McpToolAnnotations | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const src = raw as Record<string, unknown>;
	const bool = (key: string): boolean | undefined => (typeof src[key] === 'boolean' ? src[key] as boolean : undefined);
	const annotations: McpToolAnnotations = {
		title: typeof src.title === 'string' ? src.title : undefined,
		readOnlyHint: bool('readOnlyHint'),
		destructiveHint: bool('destructiveHint'),
		idempotentHint: bool('idempotentHint'),
		openWorldHint: bool('openWorldHint'),
	};
	const hasRecognisedField = annotations.title !== undefined
		|| annotations.readOnlyHint !== undefined
		|| annotations.destructiveHint !== undefined
		|| annotations.idempotentHint !== undefined
		|| annotations.openWorldHint !== undefined;
	return hasRecognisedField ? annotations : undefined;
}
