import { type AcpAgentDefinition } from './protocol';
export interface AcpDiagnostic {
    id: string;
    status: 'unavailable' | 'failed' | 'session-ready' | 'prompt-completed' | 'cancelled';
    phase: 'launch' | 'initialize' | 'session' | 'prompt';
    authMethods: string[];
    modes: string[];
    textChunks: number;
    permissionsDenied: number;
    durationMs: number;
    error?: string;
    recovery?: string;
}
/** Bounded real protocol probe. Never grants tool permissions or records provider output/credentials. */
export declare function diagnoseAcp(agent: AcpAgentDefinition, cwd: string, options?: {
    live?: boolean;
    mode?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}): Promise<AcpDiagnostic>;
//# sourceMappingURL=AcpDiagnostics.d.ts.map