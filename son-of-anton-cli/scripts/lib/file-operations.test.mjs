/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameAfterExit } from './file-operations.mjs';

test('Windows relocation waits for transient executable locks', async () => {
	let attempts = 0;
	const delays = [];
	await renameAfterExit('sota.exe', 'relocated.exe', { platform: 'win32', rename: async () => { if (++attempts < 3) { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } }, delay: async ms => { delays.push(ms); } });
	assert.deepEqual({ attempts, delays }, { attempts: 3, delays: [100, 200] });
});

test('permanent errors and non-Windows failures are never hidden', async () => {
	for (const [platform, code] of [['win32', 'ENOENT'], ['linux', 'EBUSY']]) {
		let attempts = 0;
		await assert.rejects(renameAfterExit('source', 'destination', { platform, rename: async () => { attempts++; throw Object.assign(new Error('failed'), { code }); }, delay: async () => assert.fail('Unexpected retry') }), { code });
		assert.equal(attempts, 1);
	}
});

test('Windows retries have a fixed upper bound and preserve the final error', async () => {
	let attempts = 0;
	const error = Object.assign(new Error('still locked'), { code: 'EPERM' });
	await assert.rejects(renameAfterExit('source', 'destination', { platform: 'win32', rename: async () => { attempts++; throw error; }, delay: async () => {} }), error);
	assert.equal(attempts, 12);
});
