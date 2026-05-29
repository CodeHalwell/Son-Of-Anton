"use strict";
// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const index_1 = require("../index");
// --- parseTraceparent ---
(0, node_test_1.describe)('parseTraceparent', () => {
    (0, node_test_1.test)('parses a valid sampled traceparent', () => {
        const result = (0, index_1.parseTraceparent)('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
        strict_1.default.deepStrictEqual(result, {
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            spanId: '00f067aa0ba902b7',
            flags: '01',
        });
    });
    (0, node_test_1.test)('parses a valid unsampled traceparent', () => {
        const result = (0, index_1.parseTraceparent)('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
        strict_1.default.ok(result !== null);
        strict_1.default.equal(result.flags, '00');
    });
    (0, node_test_1.test)('returns null for wrong version', () => {
        strict_1.default.equal((0, index_1.parseTraceparent)('01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null);
    });
    (0, node_test_1.test)('returns null when too few parts', () => {
        strict_1.default.equal((0, index_1.parseTraceparent)('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7'), null);
    });
    (0, node_test_1.test)('returns null for short traceId', () => {
        strict_1.default.equal((0, index_1.parseTraceparent)('00-4bf92f35-00f067aa0ba902b7-01'), null);
    });
    (0, node_test_1.test)('returns null for non-hex characters', () => {
        strict_1.default.equal((0, index_1.parseTraceparent)('00-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ-00f067aa0ba902b7-01'), null);
    });
    (0, node_test_1.test)('returns null for empty string', () => {
        strict_1.default.equal((0, index_1.parseTraceparent)(''), null);
    });
});
// --- formatTraceparent ---
(0, node_test_1.describe)('formatTraceparent', () => {
    (0, node_test_1.test)('round-trips through parse then format', () => {
        const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        const ctx = (0, index_1.parseTraceparent)(header);
        strict_1.default.equal((0, index_1.formatTraceparent)(ctx), header);
    });
});
// --- createRootTrace ---
(0, node_test_1.describe)('createRootTrace', () => {
    (0, node_test_1.test)('generates 32-char hex traceId and 16-char hex spanId', () => {
        const ctx = (0, index_1.createRootTrace)();
        strict_1.default.match(ctx.traceId, /^[0-9a-f]{32}$/);
        strict_1.default.match(ctx.spanId, /^[0-9a-f]{16}$/);
        strict_1.default.equal(ctx.flags, '01');
    });
    (0, node_test_1.test)('each call produces a unique traceId', () => {
        const a = (0, index_1.createRootTrace)();
        const b = (0, index_1.createRootTrace)();
        strict_1.default.notEqual(a.traceId, b.traceId);
    });
});
// --- createChildSpan ---
(0, node_test_1.describe)('createChildSpan', () => {
    (0, node_test_1.test)('inherits traceId and flags from parent', () => {
        const parent = (0, index_1.createRootTrace)();
        const child = (0, index_1.createChildSpan)(parent);
        strict_1.default.equal(child.traceId, parent.traceId);
        strict_1.default.equal(child.flags, parent.flags);
    });
    (0, node_test_1.test)('generates a new spanId', () => {
        const parent = (0, index_1.createRootTrace)();
        const child = (0, index_1.createChildSpan)(parent);
        strict_1.default.notEqual(child.spanId, parent.spanId);
        strict_1.default.match(child.spanId, /^[0-9a-f]{16}$/);
    });
});
// --- extractOrCreateTraceContext ---
(0, node_test_1.describe)('extractOrCreateTraceContext', () => {
    function makeReq(headers = {}) {
        return { headers };
    }
    (0, node_test_1.test)('creates a root trace when no traceparent header is present', () => {
        const req = makeReq();
        const ctx = (0, index_1.extractOrCreateTraceContext)(req);
        strict_1.default.match(ctx.traceId, /^[0-9a-f]{32}$/);
        strict_1.default.match(ctx.spanId, /^[0-9a-f]{16}$/);
    });
    (0, node_test_1.test)('creates a child span when a valid traceparent header is present', () => {
        const req = makeReq({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
        const ctx = (0, index_1.extractOrCreateTraceContext)(req);
        strict_1.default.equal(ctx.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
        strict_1.default.notEqual(ctx.spanId, '00f067aa0ba902b7'); // new spanId generated
    });
    (0, node_test_1.test)('memoises: repeated calls return the same context', () => {
        const req = makeReq();
        const first = (0, index_1.extractOrCreateTraceContext)(req);
        const second = (0, index_1.extractOrCreateTraceContext)(req);
        strict_1.default.equal(first, second);
    });
    (0, node_test_1.test)('ignores invalid traceparent and creates a root trace', () => {
        const req = makeReq({ traceparent: 'not-valid' });
        const ctx = (0, index_1.extractOrCreateTraceContext)(req);
        strict_1.default.match(ctx.traceId, /^[0-9a-f]{32}$/);
    });
});
// --- addTraceHeaders ---
(0, node_test_1.describe)('addTraceHeaders', () => {
    (0, node_test_1.test)('adds traceparent to an existing headers object', () => {
        const ctx = (0, index_1.createRootTrace)();
        const result = (0, index_1.addTraceHeaders)({ 'Content-Type': 'application/json' }, ctx);
        strict_1.default.equal(result['Content-Type'], 'application/json');
        strict_1.default.equal(result['traceparent'], (0, index_1.formatTraceparent)(ctx));
    });
    (0, node_test_1.test)('does not mutate the original headers object', () => {
        const ctx = (0, index_1.createRootTrace)();
        const original = { Authorization: 'Bearer tok' };
        (0, index_1.addTraceHeaders)(original, ctx);
        strict_1.default.equal(Object.keys(original).length, 1);
    });
});
// --- logHttpRequest ---
(0, node_test_1.describe)('logHttpRequest', () => {
    (0, node_test_1.test)('emits valid JSON with all required fields', () => {
        const ctx = (0, index_1.createRootTrace)();
        const lines = [];
        const origLog = console.log;
        console.log = (line) => lines.push(line);
        try {
            (0, index_1.logHttpRequest)('test-service', ctx, 'GET', '/health', 200, 12.5);
        }
        finally {
            console.log = origLog;
        }
        strict_1.default.equal(lines.length, 1);
        const parsed = JSON.parse(lines[0]);
        strict_1.default.deepStrictEqual(parsed, {
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
//# sourceMappingURL=tracing.test.js.map