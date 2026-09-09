/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, stat, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const signingSecrets = {
	MACOS_SIGNING_CERT_P12: Buffer.from('test-only-certificate').toString('base64'),
	MACOS_SIGNING_CERT_PASSWORD: 'test-only-password',
	MACOS_SIGNING_IDENTITY: 'Developer ID Application: Fixture',
};
const notarySecrets = {
	MACOS_NOTARY_KEY_BASE64: Buffer.from('test-only-private-key').toString('base64'),
	MACOS_NOTARY_KEY_ID: 'TESTKEY', MACOS_NOTARY_KEY_ISSUER: 'test-issuer',
};

async function fixture(t, platform = 'darwin') {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'sota-package-test-'))), root = path.join(directory, 'repo');
	t.after(() => rm(directory, { recursive: true, force: true }));
	await mkdir(path.join(root, 'scripts'), { recursive: true });
	for (const name of ['package-ide.mjs', 'sign-ide.mjs', 'ide-release-policy.mjs']) { await cp(new URL(`../${name}`, import.meta.url), path.join(root, 'scripts', name)); }
	const preload = path.join(root, 'mock-tools.mjs');
	await cp(new URL('./fixtures/ide-signing-subprocess.mjs', import.meta.url), preload);
	const product = { nameLong: 'Fixture IDE', nameShort: 'Fixture', applicationName: 'fixture', linuxIconName: 'fixture', urlProtocol: 'fixture', darwinBundleIdentifier: 'com.example.fixture' };
	await writeFile(path.join(root, 'product.json'), JSON.stringify(product));
	await writeFile(path.join(root, 'package.json'), '{"version":"1.2.3"}');
	const target = `${platform}-${platform === 'darwin' ? 'arm64' : 'x64'}`;
	const source = path.join(directory, `Son of Anton-${target}`), app = platform === 'darwin' ? path.join(source, `${product.nameLong}.app`) : source;
	const resources = path.join(app, platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app');
	await mkdir(resources, { recursive: true });
	await writeFile(path.join(resources, 'product.json'), '{"version":"1.2.3","commit":"fixture-commit"}');
	await writeFile(path.join(app, 'fixture.exe'), 'application');
	await writeFile(path.join(app, 'chrome-sandbox'), 'sandbox');
	const osxSign = path.join(root, 'build/node_modules/@electron/osx-sign'); await mkdir(osxSign, { recursive: true });
	await writeFile(path.join(root, 'build/package.json'), '{}');
	await writeFile(path.join(osxSign, 'index.js'), 'exports.sign = async ({ app }) => { require("node:fs").appendFileSync(process.env.SOTA_PACKAGE_TEST_LOG, JSON.stringify({ tool: "osx-sign", target: app }) + "\\n"); };');
	const resourcesLinux = path.join(root, 'resources/linux'); await mkdir(resourcesLinux, { recursive: true });
	for (const name of ['code.png', 'code.desktop', 'code-url-handler.desktop']) { await writeFile(path.join(resourcesLinux, name), 'fixture'); }
	const kits = path.join(root, 'kits'); await mkdir(path.join(kits, 'Windows Kits/10/bin/10.0.1/x64'), { recursive: true });
	const log = path.join(root, 'commands.jsonl'); await writeFile(log, '');
	const env = { ...process.env };
	for (const key of Object.keys(env)) { if (/^(MACOS_|WINDOWS_|SOTA_|GITHUB_REF$|NODE_OPTIONS$)/.test(key)) { delete env[key]; } }
	Object.assign(env, { SOTA_PACKAGE_TEST_ROOT: root, SOTA_PACKAGE_TEST_LOG: log, SOTA_PACKAGE_TEST_PLATFORM: platform, SOTA_RELEASE_CHANNEL: 'preview', 'ProgramFiles(x86)': kits, TEMP: root, TMP: root, TMPDIR: root });
	const output = path.join(root, '.build/ide-release', target);
	return {
		root, output, app,
		run: overrides => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(root, 'scripts/package-ide.mjs')], { env: { ...env, ...overrides }, encoding: 'utf8' }),
		commands: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
		manifest: async () => JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')),
	};
}

async function assertSecretsRemoved(commands) {
	for (const command of commands) {
		if (command.key) { await assert.rejects(stat(path.dirname(command.key)), { code: 'ENOENT' }); }
		if (command.keychain) { await assert.rejects(stat(path.dirname(command.keychain)), { code: 'ENOENT' }); }
	}
	assert.equal(commands.filter(command => command.operation === 'create-keychain').length, commands.filter(command => command.operation === 'delete-keychain').length);
}

test('workflow base64 credentials sign, notarize and staple the final DMG before manifest hashing', async t => {
	const build = await fixture(t), result = build.run({ ...signingSecrets, ...notarySecrets, SOTA_RELEASE_CHANNEL: 'stable' });
	assert.equal(result.status, 0, result.stderr);
	const manifest = await build.manifest(), commands = await build.commands();
	const dmg = path.join(build.output, manifest.files.find(file => file.name.endsWith('.dmg')).name);
	assert.deepEqual(commands.filter(command => command.target === dmg).map(command => command.tool === 'codesign' ? command.args.includes('--verify') ? 'verify' : 'sign' : command.operation ?? command.tool), ['hdiutil', 'sign', 'verify', 'submit', 'staple', 'validate']);
	assert.deepEqual(commands.filter(command => command.operation === 'submit').map(command => path.extname(command.target)), ['.zip', '.dmg']);
	assert.equal(commands.find(command => command.tool === 'codesign' && command.args.includes('--identifier')).args.at(-2), 'com.example.fixture.dmg');
	assert.equal(manifest.signing, 'developer-id-notarized');
	for (const file of manifest.files) {
		const bytes = await readFile(path.join(build.output, file.name));
		assert.deepEqual([file.bytes, file.sha256], [bytes.length, createHash('sha256').update(bytes).digest('hex')]);
	}
	await assertSecretsRemoved(commands);
});

for (const [name, secrets, expected] of [['unsigned', {}, 'ad-hoc'], ['Developer ID without notarization', signingSecrets, 'developer-id']]) {
	test(`preview packaging truthfully reports ${name}`, async t => {
		const build = await fixture(t), result = build.run(secrets);
		assert.equal(result.status, 0, result.stderr);
		assert.equal((await build.manifest()).signing, expected);
		assert.equal((await build.commands()).some(command => command.operation === 'submit'), false);
		await assertSecretsRemoved(await build.commands());
	});
}

for (const [name, secrets] of [['missing signing', {}], ['missing notarization', signingSecrets], ['partial notary credentials', { ...signingSecrets, MACOS_NOTARY_KEY_BASE64: notarySecrets.MACOS_NOTARY_KEY_BASE64 }]]) {
	test(`stable packaging rejects ${name}`, async t => {
		const build = await fixture(t), result = build.run({ ...secrets, SOTA_RELEASE_CHANNEL: 'stable' });
		assert.notEqual(result.status, 0);
		await assert.rejects(build.manifest(), { code: 'ENOENT' });
		await assertSecretsRemoved(await build.commands());
	});
}

for (const failure of ['submit', 'invalid', 'malformed', 'staple', 'validate', 'missing-result', 'wrong-target', 'missing-status']) {
	test(`final DMG ${failure} failure cannot publish a notarized manifest`, async t => {
		const build = await fixture(t), result = build.run({ ...signingSecrets, ...notarySecrets, SOTA_RELEASE_CHANNEL: 'stable', SOTA_PACKAGE_TEST_FAILURE: failure });
		assert.notEqual(result.status, 0);
		await assert.rejects(build.manifest(), { code: 'ENOENT' });
		await assertSecretsRemoved(await build.commands());
	});
}

for (const platform of ['win32', 'linux']) {
	test(`${platform} unsigned preview packaging retains its manifest and installer formats`, async t => {
		const build = await fixture(t, platform), result = build.run({});
		assert.equal(result.status, 0, result.stderr);
		const manifest = await build.manifest();
		assert.equal(manifest.signing, 'unsigned');
		assert.deepEqual(manifest.files.map(file => path.extname(file.name)), platform === 'win32' ? ['.exe', '.zip'] : ['.gz', '.deb']);
	});
}

test('Windows stable packaging verifies both application and installer signing outcomes', async t => {
	const build = await fixture(t, 'win32'), result = build.run({ SOTA_RELEASE_CHANNEL: 'stable', WINDOWS_SIGNING_CERT_BASE64: Buffer.from('fixture').toString('base64'), WINDOWS_SIGNING_PASSWORD: 'test-password' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal((await build.manifest()).signing, 'authenticode');
	assert.deepEqual((await build.commands()).filter(command => command.tool === 'signtool.exe').map(command => command.args[0]), ['sign', 'verify', 'sign', 'verify']);
});
