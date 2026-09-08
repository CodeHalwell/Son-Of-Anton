/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), target = path.resolve(process.argv[2]);
const run = (command, args) => {
	const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 30 * 60_000 });
	// Do not interpolate arguments: certificate passwords are passed to OS signing tools.
	if (result.error || result.status !== 0) { throw new Error(`${path.basename(command)} failed (${result.status}). Check the signing identity and certificate configuration.`); }
	return result.stdout;
};
if (process.platform === 'darwin') {
	const keys = ['MACOS_SIGNING_CERT_P12', 'MACOS_SIGNING_CERT_PASSWORD', 'MACOS_SIGNING_IDENTITY'];
	const configured = keys.filter(key => process.env[key]);
	if (configured.length && configured.length !== keys.length) { throw new Error('Configure all three macOS signing secrets or remove the incomplete configuration'); }
	if (!configured.length) {
		if (process.env.SOTA_REQUIRE_SIGNING === 'true') { throw new Error('Developer ID signing is required for this release'); }
		run('codesign', ['--force', '--deep', '--sign', '-', target]);
		run('codesign', ['--verify', '--deep', '--strict', target]);
		console.log('macOS application is ad-hoc signed. Gatekeeper distribution signing is not configured.');
	} else {
		const directory = await mkdtemp(path.join(tmpdir(), 'sota-ide-signing-')), keychain = path.join(directory, 'build.keychain-db');
		const password = randomBytes(32).toString('hex'), cert = path.join(directory, 'certificate.p12');
		const original = run('security', ['list-keychains', '-d', 'user']).split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
		try {
			await writeFile(cert, Buffer.from(process.env.MACOS_SIGNING_CERT_P12, 'base64'), { mode: 0o600 });
			run('security', ['create-keychain', '-p', password, keychain]); run('security', ['set-keychain-settings', '-lut', '21600', keychain]); run('security', ['unlock-keychain', '-p', password, keychain]);
			run('security', ['import', cert, '-P', process.env.MACOS_SIGNING_CERT_PASSWORD, '-A', '-t', 'cert', '-f', 'pkcs12', '-k', keychain]);
			run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain]); run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...original]);
			const { sign } = createRequire(new URL('../build/package.json', import.meta.url))('@electron/osx-sign');
			await sign({ app: target, identity: process.env.MACOS_SIGNING_IDENTITY, keychain, platform: 'darwin', preAutoEntitlements: false, preEmbedProvisioningProfile: false, optionsForFile: file => ({ hardenedRuntime: true, entitlements: path.join(root, 'build/azure-pipelines/darwin', file.includes('Helper (GPU)') ? 'helper-gpu-entitlements.plist' : file.includes('Helper (Renderer)') ? 'helper-renderer-entitlements.plist' : file.includes('Helper (Plugin)') ? 'helper-plugin-entitlements.plist' : 'app-entitlements.plist') }) });
			run('codesign', ['--verify', '--deep', '--strict', target]);
		} finally {
			try { run('security', ['list-keychains', '-d', 'user', '-s', ...original]); }
			finally {
				try { run('security', ['delete-keychain', keychain]); }
				finally { await rm(directory, { recursive: true, force: true }); }
			}
		}
	}
	const notaryKeys = ['MACOS_NOTARY_KEY_BASE64', 'MACOS_NOTARY_KEY_ID', 'MACOS_NOTARY_KEY_ISSUER'];
	const notary = notaryKeys.filter(key => process.env[key]);
	if (notary.length && (notary.length !== notaryKeys.length || !configured.length)) { throw new Error('Notarization requires all notary secrets and Developer ID signing'); }
	if (process.env.SOTA_REQUIRE_SIGNING === 'true' && !notary.length) { throw new Error('Notarization is required for this release'); }
	if (notary.length) {
		const directory = await mkdtemp(path.join(tmpdir(), 'sota-ide-notary-'));
		try {
			const key = path.join(directory, 'AuthKey.p8'), zip = path.join(directory, 'app.zip'); await writeFile(key, Buffer.from(process.env.MACOS_NOTARY_KEY_BASE64, 'base64'), { mode: 0o600 });
			run('ditto', ['-c', '-k', '--keepParent', target, zip]);
			run('xcrun', ['notarytool', 'submit', zip, '--key', key, '--key-id', process.env.MACOS_NOTARY_KEY_ID, '--issuer', process.env.MACOS_NOTARY_KEY_ISSUER, '--wait', '--timeout', '30m']);
			run('xcrun', ['stapler', 'staple', target]); run('xcrun', ['stapler', 'validate', target]);
		} finally { await rm(directory, { recursive: true, force: true }); }
	}
} else if (process.platform === 'win32') {
	const keys = ['WINDOWS_SIGNING_CERT_BASE64', 'WINDOWS_SIGNING_PASSWORD'];
	const configured = keys.filter(key => process.env[key]);
	if (configured.length && configured.length !== keys.length) { throw new Error('Configure both Windows certificate secrets'); }
	if (!configured.length) { if (process.env.SOTA_REQUIRE_SIGNING === 'true') { throw new Error('Windows signing is required'); } console.log('Windows package is unsigned.'); }
	else {
		const directory = await mkdtemp(path.join(tmpdir(), 'sota-ide-signing-'));
		try {
			const cert = path.join(directory, 'certificate.pfx'); await writeFile(cert, Buffer.from(process.env.WINDOWS_SIGNING_CERT_BASE64, 'base64'), { mode: 0o600 });
			const kits = path.join(process.env['ProgramFiles(x86)'], 'Windows Kits/10/bin');
			const versions = (await readdir(kits)).filter(name => /^10\./.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
			const signtool = path.join(kits, versions[0], 'x64/signtool.exe');
			async function sign(file) {
				if ((await stat(file)).isDirectory()) { for (const entry of await readdir(file)) { await sign(path.join(file, entry)); } }
				else if (/\.(exe|dll|node)$/i.test(file)) { run(signtool, ['sign', '/fd', 'SHA256', '/td', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/f', cert, '/p', process.env.WINDOWS_SIGNING_PASSWORD, file]); run(signtool, ['verify', '/pa', file]); }
			}
			await sign(target);
		} finally { await rm(directory, { recursive: true, force: true }); }
	}
}
