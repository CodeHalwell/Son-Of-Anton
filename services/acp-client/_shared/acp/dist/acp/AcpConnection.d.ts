import { AcpPeer } from './AcpPeer';
import { type AcpImage, type AcpAgentDefinition, type AcpInitializeResult, type AcpMcpServer, type AcpPermissionHandler, type AcpPromptResult, type AcpUpdate } from './protocol';
/** One agent process and conversation. Never replays a prompt after a transport failure. */
export declare class AcpConnection {
    readonly definition: AcpAgentDefinition;
    readonly cwd: string;
    private readonly child;
    readonly peer: AcpPeer;
    private sessionId?;
    private active?;
    private stopping?;
    private transportStopping?;
    private processError?;
    private exited;
    private readonly exitPromise;
    private readonly spawned;
    initialization?: AcpInitializeResult;
    availableModes: string[];
    availableModels: Array<{
        id: string;
        name: string;
    }>;
    modelsAdvertised: boolean;
    modelsTruncated: boolean;
    constructor(definition: AcpAgentDefinition, cwd: string);
    get isConnected(): boolean;
    get remoteSessionId(): string | undefined;
    initialize(signal?: AbortSignal): Promise<AcpInitializeResult>;
    newSession(mcpServers?: AcpMcpServer[], signal?: AbortSignal, modeId?: string): Promise<string>;
    /** Load only a settled session. Replay notifications are deliberately not forwarded as live work. */
    loadSession(sessionId: string, mcpServers?: AcpMcpServer[], signal?: AbortSignal, modeId?: string): Promise<void>;
    private selectModel;
    prompt(text: string, options: {
        images?: readonly AcpImage[];
        signal: AbortSignal;
        update?: (update: AcpUpdate) => void;
        permission?: AcpPermissionHandler;
        timeoutMs?: number;
    }): Promise<AcpPromptResult>;
    private stopAfterProcessExit;
    stop(): Promise<void>;
    private handleRequest;
}
//# sourceMappingURL=AcpConnection.d.ts.map