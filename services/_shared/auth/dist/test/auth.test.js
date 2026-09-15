"use strict";
// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const node_http_1 = require("node:http");
const index_1 = require("../index");
const TOKEN = 'super-secret-token';
function fakeRequest(url, authorization) {
    return { url, headers: authorization ? { authorization } : {} };
}
function fakeResponse() {
    const captured = { res: undefined, status: undefined, body: undefined };
    captured.res = {
        writeHead(status) {
            captured.status = status;
            return this;
        },
        end(body) {
            captured.body = body;
            return this;
        },
    };
    return captured;
}
(0, node_test_1.afterEach)(() => {
    delete process.env[index_1.SERVICE_TOKEN_ENV];
});
(0, node_test_1.describe)('isExemptPath', () => {
    (0, node_test_1.test)('exempts health and metrics, including with query strings', () => {
        strict_1.default.deepStrictEqual(['/health', '/metrics', '/health?ready=1', '/metrics?x=1', '/tasks', '/'].map(index_1.isExemptPath), [true, true, true, true, false, false]);
    });
});
(0, node_test_1.describe)('isAuthorized', () => {
    (0, node_test_1.test)('accepts a matching bearer token and rejects everything else', () => {
        strict_1.default.deepStrictEqual([
            (0, index_1.isAuthorized)({ authorization: `Bearer ${TOKEN}` }, TOKEN),
            (0, index_1.isAuthorized)({ authorization: `bearer ${TOKEN}` }, TOKEN),
            (0, index_1.isAuthorized)({ authorization: `Bearer ${TOKEN}x` }, TOKEN),
            (0, index_1.isAuthorized)({ authorization: `Bearer ${TOKEN}` }, 'other'),
            (0, index_1.isAuthorized)({ authorization: TOKEN }, TOKEN),
            (0, index_1.isAuthorized)({}, TOKEN),
        ], [true, true, false, false, false, false]);
    });
});
(0, node_test_1.describe)('enforceHttpAuth', () => {
    (0, node_test_1.test)('exempt paths and valid tokens pass; missing configuration and mismatches get 401', () => {
        // Exempt path — no token required.
        strict_1.default.strictEqual((0, index_1.enforceHttpAuth)(fakeRequest('/health'), fakeResponse().res, TOKEN), true);
        // Valid token.
        strict_1.default.strictEqual((0, index_1.enforceHttpAuth)(fakeRequest('/tasks', `Bearer ${TOKEN}`), fakeResponse().res, TOKEN), true);
        // Missing server configuration must never disable authentication.
        strict_1.default.strictEqual((0, index_1.enforceHttpAuth)(fakeRequest('/tasks'), fakeResponse().res, ''), false);
        // Missing/invalid token → 401 written.
        const captured = fakeResponse();
        strict_1.default.strictEqual((0, index_1.enforceHttpAuth)(fakeRequest('/tasks', 'Bearer nope'), captured.res, TOKEN), false);
        strict_1.default.strictEqual(captured.status, 401);
        strict_1.default.match(captured.body ?? '', /Unauthorized/);
    });
    (0, node_test_1.test)('falls back to the SOTA_SERVICE_TOKEN environment variable', () => {
        process.env[index_1.SERVICE_TOKEN_ENV] = TOKEN;
        strict_1.default.strictEqual((0, index_1.enforceHttpAuth)(fakeRequest('/tasks', `Bearer ${TOKEN}`), fakeResponse().res), true);
        strict_1.default.strictEqual((0, index_1.enforceHttpAuth)(fakeRequest('/tasks', 'Bearer nope'), fakeResponse().res), false);
    });
});
(0, node_test_1.describe)('createAuthMiddleware', () => {
    function run(path, authorization, token) {
        const middleware = (0, index_1.createAuthMiddleware)(token);
        let nexted = false;
        let status;
        const req = { path, headers: authorization ? { authorization } : {} };
        const res = { status(code) { status = code; return this; }, json() { return this; } };
        middleware(req, res, () => { nexted = true; });
        return { nexted, status };
    }
    (0, node_test_1.test)('passes exempt paths and valid tokens; blocks missing configuration and mismatches', () => {
        strict_1.default.deepStrictEqual(run('/health', undefined, TOKEN), { nexted: true, status: undefined });
        strict_1.default.deepStrictEqual(run('/tasks', `Bearer ${TOKEN}`, TOKEN), { nexted: true, status: undefined });
        strict_1.default.deepStrictEqual(run('/tasks', undefined, ''), { nexted: false, status: 401 });
        strict_1.default.deepStrictEqual(run('/tasks', 'Bearer nope', TOKEN), { nexted: false, status: 401 });
    });
});
(0, node_test_1.describe)('serviceAuthHeaders', () => {
    (0, node_test_1.test)('emits a bearer header only when a token is configured', () => {
        strict_1.default.deepStrictEqual((0, index_1.serviceAuthHeaders)(TOKEN), { Authorization: `Bearer ${TOKEN}` });
        strict_1.default.deepStrictEqual((0, index_1.serviceAuthHeaders)(''), {});
        process.env[index_1.SERVICE_TOKEN_ENV] = TOKEN;
        strict_1.default.deepStrictEqual((0, index_1.serviceAuthHeaders)(), { Authorization: `Bearer ${TOKEN}` });
    });
});
(0, node_test_1.describe)('requireServiceToken', () => {
    (0, node_test_1.test)('returns the configured token', () => {
        process.env[index_1.SERVICE_TOKEN_ENV] = TOKEN;
        strict_1.default.strictEqual((0, index_1.requireServiceToken)('test-service'), TOKEN);
    });
});
(0, node_test_1.test)('a live HTTP server never serves protected data without configured authentication', async (t) => {
    const server = (0, node_http_1.createServer)((request, response) => {
        if (!(0, index_1.enforceHttpAuth)(request, response, '')) {
            return;
        }
        response.end('protected data');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
    const address = server.address();
    strict_1.default.ok(address && typeof address !== 'string');
    for (const authorization of [undefined, 'Bearer attacker-supplied']) {
        const headers = authorization ? { Authorization: authorization } : {};
        const response = await fetch(`http://127.0.0.1:${address.port}/tasks`, { headers });
        strict_1.default.equal(response.status, 401);
        strict_1.default.ok(!(await response.text()).includes('protected data'));
    }
    strict_1.default.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
});
//# sourceMappingURL=auth.test.js.map