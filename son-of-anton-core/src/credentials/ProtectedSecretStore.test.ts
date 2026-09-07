/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ProtectedSecretStore, type SecretCommand } from './ProtectedSecretStore';

function keychain() {
	const entries = new Map<string, string>();
	const calls: Array<{ args: string[]; input?: string }> = [];
	const execute: SecretCommand = async (_command, args, input) => {
		calls.push({ args, input });
		if (args[0] === '-i') {
			const parts = input!.trim().split(' ');
			entries.set(parts[parts.indexOf('-a') + 1], parts[parts.indexOf('-w') + 1]);
			return { code: 0, stdout: '' };
		}
		const account = args[args.indexOf('-a') + 1];
		if (args[0] === 'delete-generic-password') { entries.delete(account); return { code: 0, stdout: '' }; }
		return entries.has(account) ? { code: 0, stdout: entries.get(account)! } : { code: 44, stdout: '' };
	};
	return { execute, calls };
}

test('protected saves, concurrent updates and revocation never put secrets in argv', async () => {
	const mock = keychain();
	const store = new ProtectedSecretStore(mock.execute, 'darwin');
	await Promise.all([store.store('provider', 'first synthetic secret'), store.store('provider', 'latest synthetic secret')]);
	assert.equal(await store.get('provider'), 'latest synthetic secret');
	await store.delete('provider');
	assert.equal(await store.get('provider'), undefined);
	assert.equal(mock.calls.some(call => call.args.some(arg => /synthetic|c3ludGhldGlj/.test(arg))), false);
});

test('legacy migration verifies saves, preserves protected values and removes only an unchanged source', async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sota-secret-test-'));
	try {
		const file = path.join(directory, 'secrets.json');
		await fs.writeFile(file, JSON.stringify({ provider: 'legacy synthetic', other: 'migrate synthetic' }));
		const store = new ProtectedSecretStore(keychain().execute, 'darwin');
		await store.store('provider', 'current synthetic');
		assert.equal(await store.migrateLegacy(file), 2);
		assert.deepEqual([await store.get('provider'), await store.get('other')], ['current synthetic', 'migrate synthetic']);
		await assert.rejects(fs.access(file));
		await fs.writeFile(file, '{"provider":"keep synthetic"}');
		const unavailable = new ProtectedSecretStore(async () => { throw new Error('locked'); }, 'darwin');
		await assert.rejects(unavailable.migrateLegacy(file), /locked/);
		assert.equal(await fs.readFile(file, 'utf8'), '{"provider":"keep synthetic"}');
	} finally { await fs.rm(directory, { recursive: true, force: true }); }
});
