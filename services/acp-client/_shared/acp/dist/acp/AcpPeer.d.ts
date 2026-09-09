import { Readable, Writable } from 'node:stream';
export interface AcpPeerHandlers {
    request?(method: string, params: unknown): Promise<unknown>;
    notification?(method: string, params: unknown): void;
    close?(error: Error): void;
}
/** Bidirectional, bounded newline JSON-RPC. Incoming requests and responses have separate namespaces. */
export declare class AcpPeer {
    private readonly input;
    private readonly output;
    private readonly handlers;
    private readonly maxFrameBytes;
    private readonly maxOutboundFrameBytes;
    private readonly decoder;
    private buffer;
    private bufferedBytes;
    private queuedBytes;
    private nextId;
    private readonly pending;
    private readonly incoming;
    private closed;
    private readonly closedController;
    readonly signal: AbortSignal;
    constructor(input: Readable, output: Writable, handlers?: AcpPeerHandlers, maxFrameBytes?: number, maxOutboundFrameBytes?: number);
    get isConnected(): boolean;
    get pendingCount(): number;
    request<T>(method: string, params?: unknown, options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<T>;
    notify(method: string, params?: unknown): void;
    dispose(error?: Error): void;
    private readonly onError;
    private readonly onEnd;
    private readonly onData;
    private write;
    private receive;
    private replyError;
}
//# sourceMappingURL=AcpPeer.d.ts.map