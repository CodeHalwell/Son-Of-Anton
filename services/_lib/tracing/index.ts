// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

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

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// --- Types ---

export interface TraceContext {
	/** 32 hex characters — W3C trace-id. */
	traceId: string;
	/** 16 hex characters — W3C parent-id (span-id for this hop). */
	spanId: string;
	/** 2 hex characters — '00' unsampled, '01' sampled. */
	flags: string;
}

// --- W3C traceparent codec ---

export function parseTraceparent(header: string): TraceContext | null {
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

export function formatTraceparent(ctx: TraceContext): string {
	return `00-${ctx.traceId}-${ctx.spanId}-${ctx.flags}`;
}

// --- Span creation ---

export function createRootTrace(): TraceContext {
	return {
		traceId: randomBytes(16).toString('hex'),
		spanId: randomBytes(8).toString('hex'),
		flags: '01',
	};
}

/** Creates a child span: inherits traceId + flags, generates a new spanId. */
export function createChildSpan(parent: TraceContext): TraceContext {
	return {
		traceId: parent.traceId,
		spanId: randomBytes(8).toString('hex'),
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
export function extractOrCreateTraceContext(req: IncomingMessage): TraceContext {
	const keyed = req as unknown as Record<symbol, TraceContext | undefined>;
	if (keyed[TRACE_CTX_KEY]) {
		return keyed[TRACE_CTX_KEY]!;
	}
	const raw = req.headers['traceparent'];
	const header = Array.isArray(raw) ? raw[0] : raw;
	const parsed = header ? parseTraceparent(header) : null;
	const ctx = parsed ? createChildSpan(parsed) : createRootTrace();
	keyed[TRACE_CTX_KEY] = ctx;
	return ctx;
}

/** Returns a new headers object with `traceparent` added for outbound requests. */
export function addTraceHeaders(
	headers: Record<string, string>,
	ctx: TraceContext,
): Record<string, string> {
	return { ...headers, traceparent: formatTraceparent(ctx) };
}

// --- URL sanitisation ---

/**
 * Strip the query string and fragment from a URL before it lands in logs or
 * span attributes. Query parameters can carry credentials (`?token=…`,
 * `?api_key=…`) or PII; redacting them upstream prevents an upstream service
 * forwarding such a request from leaking secrets into Jaeger / structured
 * log aggregators. The path portion is preserved verbatim so route grouping
 * (e.g. `/api/users/123`) still works for trace search.
 */
export function stripQuery(url: string): string {
	const queryIndex = url.indexOf('?');
	const fragmentIndex = url.indexOf('#');
	let end = url.length;
	if (queryIndex !== -1 && queryIndex < end) {
		end = queryIndex;
	}
	if (fragmentIndex !== -1 && fragmentIndex < end) {
		end = fragmentIndex;
	}
	return url.slice(0, end);
}

// --- Structured logging ---

export function logHttpRequest(
	serviceName: string,
	ctx: TraceContext,
	method: string,
	url: string,
	status: number,
	latencyMs: number,
): void {
	console.log(JSON.stringify({
		service: serviceName,
		traceId: ctx.traceId,
		spanId: ctx.spanId,
		method,
		url: stripQuery(url),
		status,
		latencyMs,
	}));
}

// --- OTLP HTTP span export ---

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	service: string;
	/** Nanoseconds since Unix epoch. */
	startEpochNs: bigint;
	/** Duration in nanoseconds. */
	durationNs: bigint;
	httpMethod: string;
	httpUrl: string;
	httpStatus: number;
}

type OtlpAttrValue =
	| { stringValue: string }
	| { intValue: number }
	| { doubleValue: number };

function makeAttr(key: string, value: string | number): { key: string; value: OtlpAttrValue } {
	return {
		key,
		value: typeof value === 'string' ? { stringValue: value } : { intValue: value },
	};
}

function buildOtlpPayload(span: OtlpSpan): string {
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
let otlpEndpoint: string | null | undefined;

function resolveOtlpEndpoint(): string | null {
	if (otlpEndpoint !== undefined) {
		return otlpEndpoint;
	}
	const raw = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
	otlpEndpoint = raw ? raw.replace(/\/$/, '') + '/v1/traces' : null;
	return otlpEndpoint;
}

async function exportSpan(span: OtlpSpan): Promise<void> {
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
	} catch {
		// Non-fatal: export failures must never affect request handling.
	}
}

/** Export a completed HTTP span. Call after the response is sent. Fire-and-forget. */
export function exportHttpSpan(
	serviceName: string,
	ctx: TraceContext,
	method: string,
	url: string,
	status: number,
	startEpochNs: bigint,
	durationNs: bigint,
): void {
	const sanitisedUrl = stripQuery(url);
	exportSpan({
		traceId: ctx.traceId,
		spanId: ctx.spanId,
		name: `${method} ${sanitisedUrl}`,
		service: serviceName,
		startEpochNs,
		durationNs,
		httpMethod: method,
		httpUrl: sanitisedUrl,
		httpStatus: status,
	}).catch(() => {});
}

// --- Express middleware ---

/**
 * Express middleware that:
 * 1. Parses or creates a W3C trace context for every request.
 * 2. Echoes `traceparent` back in the response headers.
 * 3. On finish, logs a structured JSON line and (if configured) exports an OTLP span.
 */
export function expressTracingMiddleware(
	serviceName: string,
): (req: any, res: any, next: () => void) => void {
	return (req: any, res: any, next: () => void): void => {
		const ctx = extractOrCreateTraceContext(req as IncomingMessage);
		const startEpochNs = BigInt(Date.now()) * 1_000_000n;
		const startHr = process.hrtime.bigint();

		(res as ServerResponse).setHeader('traceparent', formatTraceparent(ctx));

		(res as ServerResponse).on('finish', () => {
			const durationNs = process.hrtime.bigint() - startHr;
			const method: string = (req as IncomingMessage).method ?? 'GET';
			const url: string = (req as IncomingMessage).url ?? '/';
			const status: number = (res as ServerResponse).statusCode;

			logHttpRequest(serviceName, ctx, method, url, status, Number(durationNs) / 1_000_000);
			exportHttpSpan(serviceName, ctx, method, url, status, startEpochNs, durationNs);
		});

		next();
	};
}
