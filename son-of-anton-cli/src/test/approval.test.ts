/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
	createApprovalGate,
	decideApproval,
	formatApprovalPrompt,
	interpretApprovalAnswer,
	resolveApprovalMode,
	type ApprovalMode,
} from '../approval';

test('resolveApprovalMode: --yes wins, else TTY prompts, else deny', () => {
	const actual: ApprovalMode[] = [
		resolveApprovalMode({ autoApprove: true, isTty: true }),
		resolveApprovalMode({ autoApprove: true, isTty: false }),
		resolveApprovalMode({ autoApprove: false, isTty: true }),
		resolveApprovalMode({ autoApprove: false, isTty: false }),
	];
	assert.deepEqual(actual, ['auto', 'auto', 'interactive', 'deny']);
});

test('interpretApprovalAnswer accepts only explicit y/yes (default no)', () => {
	const inputs = ['y', 'Y', 'yes', 'YES', ' y ', '', 'n', 'no', 'nope', 'yeah', 'ok'];
	const actual = inputs.map(interpretApprovalAnswer);
	assert.deepEqual(actual, [true, true, true, true, true, false, false, false, false, false, false]);
});

test('decideApproval: auto approves, deny refuses, interactive follows the answer', () => {
	assert.deepEqual(decideApproval('auto'), { approved: true });

	const deny = decideApproval('deny');
	assert.equal(deny.approved, false);
	assert.match(deny.reason ?? '', /yes/); // mentions the --yes escape hatch

	assert.deepEqual(decideApproval('interactive', 'y'), { approved: true });
	assert.deepEqual(decideApproval('interactive', 'n'), { approved: false, reason: 'declined by user' });
	// A bare Enter (empty answer) is a decline, not an approval.
	assert.deepEqual(decideApproval('interactive', undefined), { approved: false, reason: 'declined by user' });
});

test('createApprovalGate resolves auto/deny without touching stdin', async () => {
	const autoGate = createApprovalGate('auto');
	const denyGate = createApprovalGate('deny');
	const auto = await autoGate({ kind: 'write', detail: 'src/foo.ts' });
	const deny = await denyGate({ kind: 'command', detail: 'npm test' });
	assert.equal(auto.approved, true);
	assert.equal(deny.approved, false);
});

test('formatApprovalPrompt renders the subject and a [y/N] default-no hint', () => {
	const writePrompt = formatApprovalPrompt({ kind: 'write', detail: 'src/foo.ts' });
	const cmdPrompt = formatApprovalPrompt({ kind: 'command', detail: 'npm test' });
	assert.match(writePrompt, /Allow write to src\/foo\.ts\?/);
	assert.match(writePrompt, /\[y\/N\]/);
	assert.match(cmdPrompt, /Allow command: npm test\?/);
	assert.match(cmdPrompt, /\[y\/N\]/);
});
