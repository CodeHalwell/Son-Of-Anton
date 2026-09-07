import { type AcpAgentDefinition, type AcpMcpServer, type AcpPermissionHandler, type AcpPromptResult, type AcpUpdate } from './protocol';
export interface AcpTurn {
    agent: AcpAgentDefinition;
    cwd: string;
    /** Stable per conversation and specialist. Never share this across unrelated work. */
    conversationId: string;
    text: string;
    /** Used only if a process was recreated, to restore host-owned conversation context. */
    initialContext?: string;
    mcpServers?: AcpMcpServer[];
    /** Explicit advertised session mode, included in the process reuse key. */
    modeId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    onUpdate?: (update: AcpUpdate) => void;
    onPermission?: AcpPermissionHandler;
}
/** Shared process budget, fair bounded queue, conversation isolation and idle process reuse. */
export declare class AcpRuntime {
    private readonly workers;
    private readonly queue;
    private readonly active;
    private readonly reaper;
    private disposed;
    private pumping;
    private readonly stopping;
    private completed;
    private failed;
    private reused;
    readonly maxProcesses: number;
    readonly maxQueue: number;
    readonly idleTimeoutMs: number;
    constructor(options?: {
        maxProcesses?: number;
        maxQueue?: number;
        idleTimeoutMs?: number;
    });
    run(turn: AcpTurn): Promise<AcpPromptResult>;
    snapshot(): {
        processes: number;
        active: number;
        queued: number;
        completed: number;
        failed: number;
        reused: number;
        maxProcesses: number;
    };
    /** Release one host conversation, including requests waiting for a process slot. */
    release(conversationId: string): Promise<void>;
    shutdown(): Promise<void>;
    private key;
    private retire;
    private pump;
    private execute;
}
//# sourceMappingURL=AcpRuntime.d.ts.map