/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Preload only in an isolated test subprocess. Every native tool is simulated;
// the production package/sign scripts themselves still run in real Node processes.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

if (!process.env.SOTA_PACKAGE_TEST_ROOT) { throw new Error('Packaging fixture requires an isolated test root'); }
const root = process.env.SOTA_PACKAGE_TEST_ROOT;
const nativePlatform = process.platform;
Object.defineProperty(process, 'platform', { value: process.env.SOTA_PACKAGE_TEST_PLATFORM });
Object.defineProperty(process, 'arch', { value: process.platform === 'darwin' ? 'arm64' : 'x64' });
// Avoid requiring symlink privileges when simulating macOS/Linux on a Windows runner.
promises.symlink = async (target, link) => promises.writeFile(link, target);
const originalSpawn = childProcess.spawnSync;
const record = event => fs.appendFileSync(process.env.SOTA_PACKAGE_TEST_LOG, `${JSON.stringify(event)}\n`);
const ok = stdout => ({ status: 0, stdout: stdout ?? '', stderr: '' });
childProcess.spawnSync = (command, args, options = {}) => {
	if (command === process.execPath && args[0] === 'scripts/sign-ide.mjs') {
		const malformed = process.env.SOTA_PACKAGE_TEST_FAILURE;
		if (['missing-result', 'wrong-target', 'missing-status'].includes(malformed) && args[1].endsWith('.dmg')) {
			return ok(malformed === 'missing-result' ? '' : JSON.stringify({ target: malformed === 'wrong-target' ? 'different.dmg' : args[1], ...(malformed === 'wrong-target' ? { signing: 'developer-id-notarized' } : {}) }));
		}
		const result = originalSpawn(command, ['--import', import.meta.url, ...args], options);
		if (result.status !== 0 && result.stderr) { process.stderr.write(result.stderr); }
		return result;
	}
	const tool = path.basename(command);
	const target = args.at(-1);
	if (command === process.execPath && args[0] === 'node_modules/gulp/bin/gulp.js') {
		if (args[1].endsWith('-user-setup')) {
			const directory = path.join(root, '.build/win32-x64/user-setup');
			fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, 'fixture-setup.exe'), 'installer');
		}
		return ok();
	}
	if (tool === 'security') {
		record({ tool, operation: args[0], ...(args[0] === 'create-keychain' ? { keychain: target } : {}) });
		return ok(args[0] === 'list-keychains' && args.length === 3 ? '"fixture-existing-keychain"\n' : '');
	}
	if (tool === 'codesign' || tool === 'signtool.exe') { record({ tool, args, target }); return ok(); }
	if (tool === 'ditto' || tool === 'hdiutil' || tool === 'dpkg-deb') {
		record({ tool, target }); fs.writeFileSync(target, `fixture ${tool} archive`); return ok();
	}
	if (tool === 'tar' || tool === '7z') { fs.writeFileSync(args[tool === 'tar' ? 1 : 2], 'fixture archive'); return ok(); }
	if (tool === 'dpkg-shlibdeps') { return ok('shlibs:Depends=libc6 (>= 2.34)\n'); }
	if (tool === 'xcrun' && args[0] === 'notarytool') {
		const key = args[args.indexOf('--key') + 1];
		if (fs.readFileSync(key, 'utf8') !== 'test-only-private-key' || (nativePlatform !== 'win32' && (fs.statSync(key).mode & 0o777) !== 0o600)) { throw new Error('Notary key was not decoded privately'); }
		record({ tool, operation: 'submit', target: args[2], key, args });
		if (args[2].endsWith('.dmg')) {
			if (process.env.SOTA_PACKAGE_TEST_FAILURE === 'submit') { return { status: 1, stdout: '', stderr: 'simulated rejection' }; }
			if (process.env.SOTA_PACKAGE_TEST_FAILURE === 'invalid') { return ok('{"status":"Invalid"}'); }
			if (process.env.SOTA_PACKAGE_TEST_FAILURE === 'malformed') { return ok('not JSON'); }
		}
		return ok('{"status":"Accepted"}');
	}
	if (tool === 'xcrun' && args[0] === 'stapler') {
		record({ tool, operation: args[1], target });
		if (target.endsWith('.dmg')) {
			if (args[1] === process.env.SOTA_PACKAGE_TEST_FAILURE) { return { status: 1, stdout: '', stderr: 'simulated stapler failure' }; }
			if (args[1] === 'staple') { fs.appendFileSync(target, '\nnotary-ticket'); }
		}
		return ok();
	}
	throw new Error(`Unexpected external packaging subprocess: ${tool}`);
};
syncBuiltinESMExports();
