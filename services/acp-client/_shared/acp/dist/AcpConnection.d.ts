import { AcpPeer } from './AcpPeer';
import { type AcpAgentDefinition, type AcpInitializeResult, type AcpMcpServer, type AcpPermissionHandler, type AcpPromptResult, type AcpUpdate } from './protocol';
/** One agent process and conversation. Never replays a prompt after a transport failure. */
export declare class AcpConnection {
    readonly definition: AcpAgentDefinition;
    readonly cwd: string;
    private readonly child;
    readonly peer: AcpPeer;
    private sessionId?;
    private active?;
    private stopping?;
    private exited;
    private readonly exitPromise;
    private readonly spawned;
    initialization?: AcpInitializeResult;
    availableModes: string[];
    constructor(definition: AcpAgentDefinition, cwd: string);
    get isConnected(): boolean;
    get remoteSessionId(): string | undefined;
    initialize(signal?: AbortSignal): Promise<AcpInitializeResult>;
    newSession(mcpServers?: AcpMcpServer[], signal?: AbortSignal, modeId?: string): Promise<string>;
    prompt(text: string, options: {
        signal: AbortSignal;
        update?: (update: AcpUpdate) => void;
        permission?: AcpPermissionHandler;
        timeoutMs?: number;
    }): Promise<AcpPromptResult>;
    stop(): Promise<void>;
    private handleRequest;
}
//# sourceMappingURL=AcpConnection.d.ts.map