"use strict";
// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const trustResolver_1 = require("../src/trust/trustResolver");
(0, node_test_1.describe)('resolveTrustLevel', () => {
    (0, node_test_1.test)('system prompts are trusted', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'system-prompt' }), 'trusted');
    });
    (0, node_test_1.test)('user messages are trusted', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'user-message' }), 'trusted');
    });
    (0, node_test_1.test)('project config is trusted', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'project-config' }), 'trusted');
    });
    (0, node_test_1.test)('external content is untrusted', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'external-content' }), 'untrusted');
    });
    (0, node_test_1.test)('MCP tool descriptions are medium trust', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'mcp-tool-description' }), 'medium');
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'mcp-tool-response' }), 'medium');
    });
    (0, node_test_1.test)('source code files are high trust', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'source-code', path: 'src/app.ts' }), 'high');
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'source-code', path: 'lib/utils.py' }), 'high');
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'source-code', path: 'main.rs' }), 'high');
    });
    (0, node_test_1.test)('documentation files are medium trust', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'documentation', path: 'README.md' }), 'medium');
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'documentation', path: 'docs/guide.md' }), 'medium');
    });
    (0, node_test_1.test)('dependency files are low trust', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'source-code', path: 'node_modules/pkg/index.js' }), 'low');
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'source-code', path: 'vendor/lib/utils.go' }), 'low');
    });
    (0, node_test_1.test)('CLAUDE.md is trusted', () => {
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'source-code', path: 'CLAUDE.md' }), 'trusted');
        strict_1.default.equal((0, trustResolver_1.resolveTrustLevel)({ type: 'source-code', path: '.claude/CLAUDE.md' }), 'trusted');
    });
});
(0, node_test_1.describe)('meetsTrustLevel', () => {
    (0, node_test_1.test)('trusted meets all levels', () => {
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('trusted', 'trusted'));
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('trusted', 'high'));
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('trusted', 'medium'));
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('trusted', 'low'));
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('trusted', 'untrusted'));
    });
    (0, node_test_1.test)('untrusted only meets untrusted', () => {
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('untrusted', 'untrusted'));
        strict_1.default.ok(!(0, trustResolver_1.meetsTrustLevel)('untrusted', 'low'));
        strict_1.default.ok(!(0, trustResolver_1.meetsTrustLevel)('untrusted', 'medium'));
        strict_1.default.ok(!(0, trustResolver_1.meetsTrustLevel)('untrusted', 'high'));
        strict_1.default.ok(!(0, trustResolver_1.meetsTrustLevel)('untrusted', 'trusted'));
    });
    (0, node_test_1.test)('medium meets medium and below', () => {
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('medium', 'medium'));
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('medium', 'low'));
        strict_1.default.ok((0, trustResolver_1.meetsTrustLevel)('medium', 'untrusted'));
        strict_1.default.ok(!(0, trustResolver_1.meetsTrustLevel)('medium', 'high'));
        strict_1.default.ok(!(0, trustResolver_1.meetsTrustLevel)('medium', 'trusted'));
    });
});
//# sourceMappingURL=trustResolver.test.js.map