/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isUntrustedToolSource } from './ContextSanitiser.js';

describe('isUntrustedToolSource', () => {
	test('MCP tools (namespaced mcp__) are untrusted', () => {
		assert.equal(isUntrustedToolSource('mcp__tickets__create_ticket'), true);
		assert.equal(isUntrustedToolSource('mcp__database__query'), true);
	});

	test('built-in and internal tools are trusted', () => {
		assert.equal(isUntrustedToolSource('read_file'), false);
		assert.equal(isUntrustedToolSource('run_command'), false);
		assert.equal(isUntrustedToolSource('todo_write'), false);
		assert.equal(isUntrustedToolSource('fetch_url'), false);
	});

	test('a tool that merely contains "mcp" but is not namespaced is trusted', () => {
		// Only the leading `mcp__` namespace marks a bridged external tool; a
		// built-in whose name happens to contain "mcp" must not be misclassified.
		assert.equal(isUntrustedToolSource('describe_mcp_status'), false);
	});
});
