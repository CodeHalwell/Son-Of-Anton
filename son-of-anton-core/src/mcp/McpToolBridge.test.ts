/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveMcpToolRiskLevel } from './McpToolBridge.js';

describe('deriveMcpToolRiskLevel', () => {
	test('read-only hint maps to safe (no approval)', () => {
		assert.equal(deriveMcpToolRiskLevel({ readOnlyHint: true }), 'safe');
	});

	test('destructive hint maps to requiresApproval', () => {
		assert.equal(deriveMcpToolRiskLevel({ readOnlyHint: false, destructiveHint: true }), 'requiresApproval');
	});

	test('absent annotations default to requiresApproval (safe default)', () => {
		assert.equal(deriveMcpToolRiskLevel(undefined), 'requiresApproval');
	});

	test('annotations without a read-only hint require approval', () => {
		// A server that declares only unrelated hints (or nothing recognised)
		// must not slip past the approval gate.
		assert.equal(deriveMcpToolRiskLevel({ openWorldHint: true }), 'requiresApproval');
		assert.equal(deriveMcpToolRiskLevel({ idempotentHint: true }), 'requiresApproval');
		assert.equal(deriveMcpToolRiskLevel({ destructiveHint: false }), 'requiresApproval');
	});

	test('read-only wins even when a contradictory destructive hint is present', () => {
		// Per the MCP spec, destructiveHint is only meaningful when the tool is
		// not read-only, so an explicit readOnlyHint:true takes precedence.
		assert.equal(deriveMcpToolRiskLevel({ readOnlyHint: true, destructiveHint: true }), 'safe');
	});

	test('a non-boolean read-only hint is not treated as read-only', () => {
		// Defensive: only a strict boolean `true` exempts a tool from approval.
		assert.equal(deriveMcpToolRiskLevel({ readOnlyHint: undefined }), 'requiresApproval');
	});
});
