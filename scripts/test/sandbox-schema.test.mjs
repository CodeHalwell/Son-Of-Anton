/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-config.js';

const config = () => ({
	network: { allowedDomains: ['github.com'], deniedDomains: ['*.example.com'] },
	filesystem: { denyRead: ['/private/key'], allowWrite: ['/tmp/project'], denyWrite: ['/tmp/project/.git/hooks'] },
	ignoreViolations: { '*': ['/dev/tty'] },
	ripgrep: { command: 'rg', args: ['--files'] },
	mandatoryDenySearchDepth: 3,
});

test('patched sandbox validation preserves filesystem, domain and record policies', () => {
	const value = config();
	assert.deepEqual(SandboxRuntimeConfigSchema.parse(value), value);
});

test('patched sandbox validation refuses broad domains and protocol-bearing domains', () => {
	for (const domain of ['*', '*.com', 'https://github.com', 'github.com:443', 'github.com/path']) {
		const value = config(); value.network.allowedDomains = [domain];
		assert.equal(SandboxRuntimeConfigSchema.safeParse(value).success, false, domain);
	}
});

test('patched sandbox validation rejects invalid filesystem paths and search limits', () => {
	const emptyPath = config(); emptyPath.filesystem.allowWrite = [''];
	assert.equal(SandboxRuntimeConfigSchema.safeParse(emptyPath).success, false);
	for (const depth of [0, 11]) {
		const value = config(); value.mandatoryDenySearchDepth = depth;
		assert.equal(SandboxRuntimeConfigSchema.safeParse(value).success, false);
	}
});
