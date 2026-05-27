// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import {
	parseTraceparent,
	formatTraceparent,
	createRootTrace,
	createChildSpan,
	extractOrCreateTraceContext,
	addTraceHeaders,
	logHttpRequest,
} from '../index';

// --- parseTraceparent ---

describe('parseTraceparent', () => {
	test('parses a valid sampled traceparent', () => {
		const result = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
		assert.deepStrictEqual(result, {
			traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
			spanId: '00f067aa0ba902b7',
			flags: '01',
		});
	});

	test('parses a valid unsampled traceparent', () => {
		const result = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
		assert.ok(result !== null);
		assert.equal(result.flags, '00');
	});

	test('returns null for wrong version', () => {
		assert.equal(parseTraceparent('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null);
	});

	test('returns null when too few parts', () => {
		assert.equal(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'), null);
	});

	test('returns null for short traceId', () => {
		assert.equal(parseTraceparent('00-4bf92f35-00f067aa0ba902b7-01'), null);
	});

	test('returns null for non-hex characters', () => {
		assert.equal(parseTraceparent('00-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ-00f067aa0ba902b7-01'), null);
	});

	test('returns null for empty string', () => {
		assert.equal(parseTraceparent(''), null);
	});
});

// --- formatTraceparent ---

describe('formatTraceparent', () => {
	test('round-trips through parse then format', () => {
		const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
		const ctx = parseTraceparent(header)!;
		assert.equal(formatTraceparent(ctx), header);
	});
});

// --- createRootTrace ---

describe('createRootTrace', () => {
	test('generates 32-char hex traceId and 16-char hex spanId', () => {
		const ctx = createRootTrace();
		assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
		assert.match(ctx.spanId, /^[0-9a-f]{16}$/);
		assert.equal(ctx.flags, '01');
	});

	test('each call produces a unique traceId', () => {
		const a = createRootTrace();
		const b = createRootTrace();
		assert.notEqual(a.traceId, b.traceId);
	});
});

// --- createChildSpan ---

describe('createChildSpan', () => {
	test('inherits traceId and flags from parent', () => {
		const parent = createRootTrace();
		const child = createChildSpan(parent);
		assert.equal(child.traceId, parent.traceId);
		assert.equal(child.flags, parent.flags);
	});

	test('generates a new spanId', () => {
		const parent = createRootTrace();
		const child = createChildSpan(parent);
		assert.notEqual(child.spanId, parent.spanId);
		assert.match(child.spanId, /^[0-9a-f]{16}$/);
	});
});

// --- extractOrCreateTraceContext ---

describe('extractOrCreateTraceContext', () => {
	function makeReq(headers: Record<string, string> = {}): IncomingMessage {
		return { headers } as unknown as IncomingMessage;
	}

	test('creates a root trace when no traceparent header is present', () => {
		const req = makeReq();
		const ctx = extractOrCreateTraceContext(req);
		assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
		assert.match(ctx.spanId, /^[0-9a-f]{16}$/);
	});

	test('creates a child span when a valid traceparent header is present', () => {
		const req = makeReq({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
		const ctx = extractOrCreateTraceContext(req);
		assert.equal(ctx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
		assert.notEqual(ctx.spanId, '00f067aa0ba902b7'); // new spanId generated
	});

	test('memoises: repeated calls return the same context', () => {
		const req = makeReq();
		const first = extractOrCreateTraceContext(req);
		const second = extractOrCreateTraceContext(req);
		assert.equal(first, second);
	});

	test('ignores invalid traceparent and creates a root trace', () => {
		const req = makeReq({ traceparent: 'not-valid' });
		const ctx = extractOrCreateTraceContext(req);
		assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
	});
});

// --- addTraceHeaders ---

describe('addTraceHeaders', () => {
	test('adds traceparent to an existing headers object', () => {
		const ctx = createRootTrace();
		const result = addTraceHeaders({ 'Content-Type': 'application/json' }, ctx);
		assert.equal(result['Content-Type'], 'application/json');
		assert.equal(result['traceparent'], formatTraceparent(ctx));
	});

	test('does not mutate the original headers object', () => {
		const ctx = createRootTrace();
		const original = { Authorization: 'Bearer tok' };
		addTraceHeaders(original, ctx);
		assert.equal(Object.keys(original).length, 1);
	});
});

// --- logHttpRequest ---

describe('logHttpRequest', () => {
	test('emits valid JSON with all required fields', () => {
		const ctx = createRootTrace();
		const lines: string[] = [];
		const origLog = console.log;
		console.log = (line: string) => lines.push(line);
		try {
			logHttpRequest('test-service', ctx, 'GET', '/health', 200, 12.5);
		} finally {
			console.log = origLog;
		}
		assert.equal(lines.length, 1);
		const parsed = JSON.parse(lines[0]!);
		assert.deepStrictEqual(parsed, {
			service: 'test-service',
			traceId: ctx.traceId,
			spanId: ctx.spanId,
			method: 'GET',
			url: '/health',
			status: 200,
			latencyMs: 12.5,
		});
	});
});
