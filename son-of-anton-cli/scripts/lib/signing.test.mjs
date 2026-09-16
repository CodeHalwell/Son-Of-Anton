/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { signMacOs, signWindows } from './sea-pipeline.mjs';

const credentials = {
	SOTA_MACOS_SIGNING_IDENTITY: 'Developer ID Application: Fixture',
	SOTA_MACOS_SIGNING_KEYCHAIN: '/fixture/signing.keychain',
	SOTA_MACOS_NOTARY_KEY_ID: 'fixture-id',
	SOTA_MACOS_NOTARY_KEY_ISSUER: 'fixture-issuer',
	SOTA_MACOS_NOTARY_KEY_PATH: '/fixture/key.p8',
};

for (const env of [{ SOTA_REQUIRE_SIGNING: 'true' }, { SOTA_MACOS_NOTARY_KEY_ID: 'partial' }, { ...credentials, SOTA_MACOS_NOTARY_KEY_PATH: '' }, { ...credentials, SOTA_MACOS_SIGNING_IDENTITY: '' }]) {
	test(`incomplete CLI signing configuration is rejected (${Object.keys(env).join(',')})`, () => {
		assert.throws(() => signMacOs('/fixture/sota', { env, spawnSync: () => assert.fail('No signing operation should run') }), /requires|required/);
	});
}

test('Windows release signing fails when required credentials or the signing tool are missing', () => {
	assert.throws(() => signWindows('/fixture/sota.exe', { env: { SOTA_REQUIRE_SIGNING: 'true' } }), /requires a certificate/);
	assert.throws(() => signWindows('/fixture/sota.exe', {
		env: { SOTA_WINDOWS_SIGNING_CERT: '/fixture/cert.pfx', SOTA_WINDOWS_SIGNING_PASSWORD: 'private-fixture-password' },
		spawnSync: () => ({ status: 1 }),
	}), /signtool is unavailable/);
});

test('Windows signing verifies the produced Authenticode signature and fails on verification errors', () => {
	for (const verifyStatus of [0, 1]) {
		const calls = [];
		const run = () => signWindows('/fixture/sota.exe', {
			env: { SOTA_WINDOWS_SIGNING_CERT: '/fixture/cert.pfx', SOTA_WINDOWS_SIGNING_PASSWORD: 'private-fixture-password', SOTA_WINDOWS_SIGNTOOL: '/fixture/signtool.exe' },
			spawnSync(command, args) { calls.push([command, args]); return { status: args[0] === 'verify' ? verifyStatus : 0 }; },
		});
		if (verifyStatus) { assert.throws(run, error => /verification failed/.test(error.message) && !error.message.includes('private-fixture-password')); }
		else { run(); }
		assert.deepEqual(calls.map(([, args]) => args[0]), ['sign', 'verify']);
	}
});

for (const outcome of ['Accepted', 'Invalid', 'command failure']) {
	test(`raw executable notarization: ${outcome}`, () => {
		const calls = [];
		const run = () => signMacOs('/fixture/sota', { env: credentials, spawnSync(command, args) {
			calls.push([command, args]);
			if (command === 'xcrun') { return { status: outcome === 'command failure' ? 1 : 0, stdout: JSON.stringify({ status: outcome }) }; }
			return { status: 0, stdout: '' };
		} });
		if (outcome === 'Accepted') { run(); }
		else { assert.throws(run, /not accept|failed/); }
		const archive = calls.find(([command]) => command === 'ditto')[1].at(-1);
		assert.equal(existsSync(archive), false, 'Temporary notary archive must be removed on every outcome');
		assert.ok(calls[0][1].includes('--entitlements'));
		assert.ok(calls[0][1].includes('--keychain'));
		assert.equal(calls.some(([, args]) => args.includes('stapler')), false);
		assert.equal(calls.some(([, args]) => args.includes('-R=notarized')), outcome === 'Accepted');
	});
}
