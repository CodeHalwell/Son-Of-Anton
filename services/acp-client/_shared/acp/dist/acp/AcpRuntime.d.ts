import { AcpSessionStore } from './AcpSessionStore';
import { type AcpCapabilities, type AcpImage, type AcpUsage, type AcpAgentDefinition, type AcpMcpServer, type AcpPermissionHandler, type AcpPromptResult, type AcpUpdate } from './protocol';
export interface AcpTurn {
    agent: AcpAgentDefinition;
    cwd: string;
    /** Stable per conversation and specialist. Never share this across unrelated work. */
    conversationId: string;
    text: string;
    images?: readonly AcpImage[];
    /** Read-only mode must also be explicitly negotiated through modeId. */
    readOnly?: boolean;
    maxToolCalls?: number;
    onUsage?: (usage: AcpUsage) => void;
    onRecovery?: (state: 'resumed' | 'transcript' | 'interrupted') => void;
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
export interface AcpRecoveryStorageIssue {
    phase: 'read' | 'before-prompt' | 'after-prompt';
    code: 'EACCES' | 'EPERM' | 'EROFS' | 'ENOSPC' | 'EDQUOT' | 'unavailable';
    contextLimited: boolean;
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
    private readonly executions;
    private readonly capabilities;
    private readonly sessionStore?;
    private readonly onRecoveryStorageIssue;
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
        sessionStore?: AcpSessionStore;
        onRecoveryStorageIssue?: (issue: AcpRecoveryStorageIssue) => void | Promise<void>;
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
    getCapabilities(agent: AcpAgentDefinition): AcpCapabilities;
    /** Release one host conversation, including requests waiting for a process slot. */
    release(conversationId: string): Promise<void>;
    /** Permanently remove only this host conversation's recovery records, after its active writes settle. */
    forgetConversation(conversationId: string): Promise<void>;
    shutdown(): Promise<void>;
    private key;
    private reportRecoveryStorageIssue;
    /** Stop waiting for optional persistence on abort without reordering or abandoning its write. */
    private saveRecoveryRecord;
    private retire;
    private pump;
    private execute;
}
//# sourceMappingURL=AcpRuntime.d.ts.map