"use strict";
// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTraceparent = parseTraceparent;
exports.formatTraceparent = formatTraceparent;
exports.createRootTrace = createRootTrace;
exports.createChildSpan = createChildSpan;
exports.extractOrCreateTraceContext = extractOrCreateTraceContext;
exports.addTraceHeaders = addTraceHeaders;
exports.logHttpRequest = logHttpRequest;
exports.exportHttpSpan = exportHttpSpan;
exports.expressTracingMiddleware = expressTracingMiddleware;
// W3C Trace Context (https://www.w3.org/TR/trace-context/) with optional OTLP export.
//
// Usage pattern:
//   Express:    app.use(expressTracingMiddleware('model-router'));
//   Plain HTTP: const ctx = extractOrCreateTraceContext(req);
//               // ... handle request ...
//               logHttpRequest('mcp-gateway', ctx, req.method, req.url, res.statusCode, latencyMs);
//               exportHttpSpan('mcp-gateway', ctx, ...);
//
// Outbound calls: pass addTraceHeaders(existingHeaders, ctx) to propagate the trace.
//
// Optional Jaeger/OTLP export: set OTEL_EXPORTER_OTLP_ENDPOINT env var.
const node_crypto_1 = require("node:crypto");
// --- W3C traceparent codec ---
function parseTraceparent(header) {
    const parts = header.split('-');
    if (parts.length !== 4) {
        return null;
    }
    const [version, traceId, spanId, flags] = parts;
    if (version !== '00') {
        return null;
    }
    if (!/^[0-9a-f]{32}$/.test(traceId)) {
        return null;
    }
    if (!/^[0-9a-f]{16}$/.test(spanId)) {
        return null;
    }
    if (!/^[0-9a-f]{2}$/.test(flags)) {
        return null;
    }
    return { traceId, spanId, flags };
}
function formatTraceparent(ctx) {
    return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}
// --- Span creation ---
function createRootTrace() {
    return {
        traceId: (0, node_crypto_1.randomBytes)(16).toString('hex'),
        spanId: (0, node_crypto_1.randomBytes)(8).toString('hex'),
        flags: '01',
    };
}
/** Creates a child span: inherits traceId + flags, generates a new spanId. */
function createChildSpan(parent) {
    return {
        traceId: parent.traceId,
        spanId: (0, node_crypto_1.randomBytes)(8).toString('hex'),
        flags: parent.flags,
    };
}
// --- Request attachment ---
const TRACE_CTX_KEY = Symbol('son-of-anton.traceContext');
/**
 * Reads the incoming `traceparent` header and creates a child span, or generates
 * a fresh root trace if no valid header is present.
 *
 * The result is memoised on the request object so repeated calls return the same context.
 */
function extractOrCreateTraceContext(req) {
    const keyed = req;
    if (keyed[TRACE_CTX_KEY]) {
        return keyed[TRACE_CTX_KEY];
    }
    const raw = req.headers['traceparent'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const parsed = header ? parseTraceparent(header) : null;
    const ctx = parsed ? createChildSpan(parsed) : createRootTrace();
    keyed[TRACE_CTX_KEY] = ctx;
    return ctx;
}
/** Returns a new headers object with `traceparent` added for outbound requests. */
function addTraceHeaders(headers, ctx) {
    return { ...headers, traceparent: formatTraceparent(ctx) };
}
// --- Structured logging ---
function logHttpRequest(serviceName, ctx, method, url, status, latencyMs) {
    console.log(JSON.stringify({
        service: serviceName,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        method,
        url,
        status,
        latencyMs,
    }));
}
function makeAttr(key, value) {
    return {
        key,
        value: typeof value === 'string' ? { stringValue: value } : { intValue: value },
    };
}
function buildOtlpPayload(span) {
    const endNs = span.startEpochNs + span.durationNs;
    return JSON.stringify({
        resourceSpans: [{
                resource: { attributes: [makeAttr('service.name', span.service)] },
                scopeSpans: [{
                        scope: { name: '@son-of-anton/tracing', version: '1.0.0' },
                        spans: [{
                                traceId: span.traceId,
                                spanId: span.spanId,
                                parentSpanId: span.parentSpanId,
                                name: span.name,
                                kind: 2, // SPAN_KIND_SERVER
                                startTimeUnixNano: String(span.startEpochNs),
                                endTimeUnixNano: String(endNs),
                                attributes: [
                                    makeAttr('http.method', span.httpMethod),
                                    makeAttr('http.url', span.httpUrl),
                                    makeAttr('http.status_code', span.httpStatus),
                                ],
                                status: { code: span.httpStatus >= 500 ? 2 : 1 }, // ERROR or OK
                            }],
                    }],
            }],
    });
}
// Cached endpoint: undefined = not yet read, null = disabled.
let otlpEndpoint;
function resolveOtlpEndpoint() {
    if (otlpEndpoint !== undefined) {
        return otlpEndpoint;
    }
    const raw = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
    otlpEndpoint = raw ? raw.replace(/\/$/, '') + '/v1/traces' : null;
    return otlpEndpoint;
}
async function exportSpan(span) {
    const endpoint = resolveOtlpEndpoint();
    if (!endpoint) {
        return;
    }
    try {
        await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: buildOtlpPayload(span),
        });
    }
    catch {
        // Non-fatal: export failures must never affect request handling.
    }
}
/** Export a completed HTTP span. Call after the response is sent. Fire-and-forget. */
function exportHttpSpan(serviceName, ctx, method, url, status, startEpochNs, durationNs) {
    exportSpan({
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        name: `${method} ${url}`,
        service: serviceName,
        startEpochNs,
        durationNs,
        httpMethod: method,
        httpUrl: url,
        httpStatus: status,
    }).catch(() => { });
}
// --- Express middleware ---
/**
 * Express middleware that:
 * 1. Parses or creates a W3C trace context for every request.
 * 2. Echoes `traceparent` back in the response headers.
 * 3. On finish, logs a structured JSON line and (if configured) exports an OTLP span.
 */
function expressTracingMiddleware(serviceName) {
    return (req, res, next) => {
        const ctx = extractOrCreateTraceContext(req);
        const startEpochNs = BigInt(Date.now()) * 1000000n;
        const startHr = process.hrtime.bigint();
        res.setHeader('traceparent', formatTraceparent(ctx));
        res.on('finish', () => {
            const durationNs = process.hrtime.bigint() - startHr;
            const method = req.method ?? 'GET';
            const url = req.url ?? '/';
            const status = res.statusCode;
            logHttpRequest(serviceName, ctx, method, url, status, Number(durationNs) / 1_000_000);
            exportHttpSpan(serviceName, ctx, method, url, status, startEpochNs, durationNs);
        });
        next();
    };
}
//# sourceMappingURL=index.js.map