/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { atomicCheckpointWrite, readCheckpointMetadata, withCheckpointLock } from './ProcessFileLock';

async function fixture(t: TestContext, platform: NodeJS.Platform = 'win32') {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-checkpoint-lock-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
	Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
	t.after(() => Object.defineProperty(process, 'platform', descriptor));
	return directory;
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
	test(`Windows checkpoint writes retain the old metadata until ${code} clears`, async t => {
		const directory = await fixture(t); const destination = path.join(directory, 'index.json');
		await fs.writeFile(destination, 'old');
		const rename = fs.rename; let attempts = 0; let committed = 0; const sources = new Set<string>();
		t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
			attempts++; sources.add(String(args[0]));
			assert.deepEqual({ old: await fs.readFile(destination, 'utf8'), next: await fs.readFile(args[0], 'utf8'), committed }, { old: 'old', next: 'new', committed: 0 });
			if (attempts < 3) { throw Object.assign(new Error('Windows sharing violation'), { code }); }
			await rename(...args);
		});
		await atomicCheckpointWrite(destination, 'new', () => { committed++; });
		assert.deepEqual({ attempts, committed, sources: sources.size, body: await fs.readFile(destination, 'utf8'), files: await fs.readdir(directory) }, { attempts: 3, committed: 1, sources: 1, body: 'new', files: ['index.json'] });
	});
}

for (const { platform, code } of [{ platform: 'win32', code: 'EIO' }, { platform: 'darwin', code: 'EPERM' }] as const) {
	test(`${platform} checkpoint writes fail immediately for non-retryable ${code}`, async t => {
		const directory = await fixture(t, platform); const destination = path.join(directory, 'index.json'); await fs.writeFile(destination, 'old');
		const error = Object.assign(new Error('Write denied'), { code }); let attempts = 0;
		t.mock.method(fs, 'rename', async () => { attempts++; throw error; });
		await assert.rejects(atomicCheckpointWrite(destination, 'new', () => assert.fail('must not commit')), candidate => candidate === error);
		assert.deepEqual({ attempts, body: await fs.readFile(destination, 'utf8'), files: await fs.readdir(directory) }, { attempts: 1, body: 'old', files: ['index.json'] });
	});
}

test('a persistent Windows sharing error bounds retries and removes the unacquired lock', async t => {
	const directory = await fixture(t); const error = Object.assign(new Error('Still locked'), { code: 'EPERM' }); let attempts = 0;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
		attempts++;
		assert.equal(readCheckpointMetadata(String(args[1]), 32), '0');
		throw error;
	});
	await assert.rejects(withCheckpointLock(directory, async () => assert.fail('must not enter')), candidate => candidate === error);
	assert.deepEqual({ attempts, files: await fs.readdir(directory) }, { attempts: 21, files: [] });
});

test('another checkpoint writer waits while a choosing ticket is being retried', async t => {
	const directory = await fixture(t); const rename = fs.rename; let retriedTicket: string | undefined; let failures = 0;
	let firstAttempt!: () => void; const retrying = new Promise<void>(resolve => { firstAttempt = resolve; });
	let active = 0; let completed = 0;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
		retriedTicket ??= String(args[1]);
		if (String(args[1]) === retriedTicket && failures < 2) {
			failures++; assert.equal(readCheckpointMetadata(retriedTicket, 32), '0'); firstAttempt();
			throw Object.assign(new Error('Reader holds choosing ticket'), { code: 'EPERM' });
		}
		await rename(...args);
	});
	const operation = async () => {
		assert.equal(failures, 2); assert.equal(active, 0); active++;
		try { await new Promise<void>(resolve => setTimeout(resolve, 30)); completed++; }
		finally { active--; }
	};
	const first = withCheckpointLock(directory, operation);
	// Surface an early failure instead of leaving the test waiting for the barrier.
	await Promise.race([retrying, first.then(() => assert.fail('must reach rename retry'))]);
	await Promise.all([first, withCheckpointLock(directory, operation)]);
	assert.deepEqual({ completed, active, files: await fs.readdir(directory) }, { completed: 2, active: 0, files: [] });
});

test('a commit callback error cannot retry an already committed checkpoint rename', async t => {
	const directory = await fixture(t); const destination = path.join(directory, 'index.json'); const rename = fs.rename; let attempts = 0;
	t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => { attempts++; await rename(...args); });
	const error = Object.assign(new Error('Commit observer failed'), { code: 'EPERM' });
	await assert.rejects(atomicCheckpointWrite(destination, 'saved', () => { throw error; }), candidate => candidate === error);
	assert.deepEqual({ attempts, body: await fs.readFile(destination, 'utf8'), files: await fs.readdir(directory) }, { attempts: 1, body: 'saved', files: ['index.json'] });
});
