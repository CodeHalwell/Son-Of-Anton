/** Stable ACP v1 subset. Optional extensions are negotiated, never assumed. */
export declare const ACP_VERSION = 1;
export interface AcpAgentDefinition {
    id: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /** Explicitly chosen from the agent's advertised authentication methods. */
    authMethodId?: string;
}
export interface AcpMcpServer {
    name: string;
    command: string;
    args: string[];
    env: Array<{
        name: string;
        value: string;
    }>;
}
export interface AcpInitializeResult {
    protocolVersion: number;
    agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: {
            image?: boolean;
            audio?: boolean;
            embeddedContext?: boolean;
        };
    };
    agentInfo?: {
        name: string;
        version: string;
        title?: string;
    };
    authMethods?: Array<{
        id: string;
        name: string;
        description?: string;
    }>;
}
export interface AcpUpdate {
    sessionUpdate: string;
    content?: {
        type: string;
        text?: string;
    } | unknown[];
    toolCallId?: string;
    title?: string;
    status?: string;
    kind?: string;
    [key: string]: unknown;
}
export interface AcpPermissionRequest {
    sessionId: string;
    toolCall: {
        toolCallId: string;
        title?: string;
        kind?: string;
        [key: string]: unknown;
    };
    options: Array<{
        optionId: string;
        name: string;
        kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
    }>;
}
export type AcpPermissionResult = {
    outcome: {
        outcome: 'cancelled';
    } | {
        outcome: 'selected';
        optionId: string;
    };
};
export type AcpPermissionHandler = (request: AcpPermissionRequest, signal: AbortSignal) => Promise<AcpPermissionResult>;
export type AcpStopReason = 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'max_turn_requests';
export interface AcpPromptResult {
    stopReason: AcpStopReason;
}
export declare class AcpError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
}
export declare function object(value: unknown): value is Record<string, unknown>;
export declare function abortError(): Error;
export declare const cancelledPermission: () => AcpPermissionResult;
export declare function validateAgent(value: unknown): asserts value is AcpAgentDefinition;
//# sourceMappingURL=protocol.d.ts.map