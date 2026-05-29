import type { IncomingMessage } from 'node:http';
export interface TraceContext {
    /** 32 hex characters — W3C trace-id. */
    traceId: string;
    /** 16 hex characters — W3C parent-id (span-id for this hop). */
    spanId: string;
    /** 2 hex characters — '00' unsampled, '01' sampled. */
    flags: string;
}
export declare function parseTraceparent(header: string): TraceContext | null;
export declare function formatTraceparent(ctx: TraceContext): string;
export declare function createRootTrace(): TraceContext;
/** Creates a child span: inherits traceId + flags, generates a new spanId. */
export declare function createChildSpan(parent: TraceContext): TraceContext;
/**
 * Reads the incoming `traceparent` header and creates a child span, or generates
 * a fresh root trace if no valid header is present.
 *
 * The result is memoised on the request object so repeated calls return the same context.
 */
export declare function extractOrCreateTraceContext(req: IncomingMessage): TraceContext;
/** Returns a new headers object with `traceparent` added for outbound requests. */
export declare function addTraceHeaders(headers: Record<string, string>, ctx: TraceContext): Record<string, string>;
export declare function logHttpRequest(serviceName: string, ctx: TraceContext, method: string, url: string, status: number, latencyMs: number): void;
/** Export a completed HTTP span. Call after the response is sent. Fire-and-forget. */
export declare function exportHttpSpan(serviceName: string, ctx: TraceContext, method: string, url: string, status: number, startEpochNs: bigint, durationNs: bigint): void;
/**
 * Express middleware that:
 * 1. Parses or creates a W3C trace context for every request.
 * 2. Echoes `traceparent` back in the response headers.
 * 3. On finish, logs a structured JSON line and (if configured) exports an OTLP span.
 */
export declare function expressTracingMiddleware(serviceName: string): (req: any, res: any, next: () => void) => void;
