/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, cp, rm, readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url)), target = `${process.platform}-${process.arch}`;
const output = path.join(root, '.build/ide-release', target);
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json')));
for (const asset of manifest.files) {
	assert.equal(path.basename(asset.name), asset.name);
	const bytes = await readFile(path.join(output, asset.name));
	assert.equal(bytes.length, asset.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
}
const directory = await mkdtemp(path.join(tmpdir(), 'sota-ide-install-')), install = path.join(directory, 'clean install');
const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 180_000, ...options });
	assert.equal(result.status, 0, `${path.basename(command)}: ${result.error?.message ?? result.stderr}`); return result.stdout;
};
let uninstaller, mounted = false;
const mount = path.join(directory, 'mount');
try {
	await mkdir(install);
	let app = process.env.SOTA_TEST_INSTALLED_APP;
	if (!app && process.platform === 'darwin') {
		const dmg = manifest.files.find(file => file.name.endsWith('.dmg')); assert.ok(dmg);
		await mkdir(mount); run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, path.join(output, dmg.name)]); mounted = true;
		const name = (await readdir(mount)).find(name => name.endsWith('.app')); assert.ok(name);
		app = path.join(install, name); run('ditto', [path.join(mount, name), app]);
		run('hdiutil', ['detach', mount]); mounted = false;
	} else if (!app && process.platform === 'win32') {
		const setup = manifest.files.find(file => file.name.endsWith('-setup.exe')); assert.ok(setup);
		const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/MERGETASKS=!runcode,!desktopicon,!quicklaunchicon,!addtopath', `/DIR=${install}`, `/LOG=${path.join(directory, 'setup.log')}`];
		run(path.join(output, setup.name), args); app = install;
		uninstaller = path.join(install, (await readdir(install)).find(name => /^unins.*\.exe$/.test(name)));
		// Reinstall the identical release to exercise replacement without losing a dedicated user profile.
		await mkdir(path.join(directory, 'profile/User'), { recursive: true });
		await writeFile(path.join(directory, 'profile/User/settings.json'), '{"sota.installationSentinel":"preserve"}');
		run(path.join(output, setup.name), args);
		assert.equal(JSON.parse(await readFile(path.join(directory, 'profile/User/settings.json'))).sota.installationSentinel, 'preserve');
	} else if (!app) {
		const deb = manifest.files.find(file => file.name.endsWith('.deb')); assert.ok(deb);
		run('dpkg-deb', ['-x', path.join(output, deb.name), install]); app = path.join(install, 'usr/share/son-of-anton');
	}
	const resources = path.join(app, process.platform === 'darwin' ? 'Contents/Resources/app' : 'resources/app');
	const product = JSON.parse(await readFile(path.join(resources, 'product.json')));
	assert.equal(product.commit, manifest.commit); assert.equal(product.version, manifest.ideVersion);
	assert.equal(product.nameLong, 'Son of Anton IDE');
	const binary = path.join(app, process.platform === 'darwin' ? `Contents/MacOS/${product.nameShort}` : process.platform === 'win32' ? `${product.nameShort}.exe` : product.applicationName);
	const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
	// Suppress the test harness's unsupported modal prompt, while keeping workspace trust disabled.
	const settingsFile = path.join(directory, 'profile/User/settings.json'); await mkdir(path.dirname(settingsFile), { recursive: true });
	let settings = {}; try { settings = JSON.parse(await readFile(settingsFile)); } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
	await writeFile(settingsFile, JSON.stringify({ ...settings, 'security.workspace.trust.startupPrompt': 'never' }));
	const cli = path.join(resources, 'out/cli.js');
	assert.match(run(binary, [cli, '--version', '--user-data-dir', path.join(directory, 'profile')], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }), new RegExp(manifest.ideVersion.replaceAll('.', '\\.')));
	const extension = path.join(resources, 'extensions/son-of-anton');
	for (const file of ['dist/extension.js', 'dist/board.js', 'media/chat-webview.js', 'dist/prompts/anton-orchestrator.prompt.md', 'runtime/codegraph/index.cjs', 'runtime/codegraph/node_modules/@son-of-anton/codegraph-napi/engine.node']) { assert.ok((await readFile(path.join(extension, file))).length, `Missing bundled ${file}`); }
	const runtime = JSON.parse(await readFile(path.join(extension, 'runtime/codegraph/manifest.json')));
	assert.deepEqual([runtime.platform, runtime.arch], [process.platform, process.arch]);
	const helper = path.join(directory, 'test-extension'); await mkdir(helper);
	await writeFile(path.join(helper, 'package.json'), JSON.stringify({ name: 'sota-install-verification', publisher: 'sota-fixture', version: '0.0.0', engines: { vscode: '^1.96.0' }, main: './tests.cjs', capabilities: { untrustedWorkspaces: { supported: true } } }));
	await cp(path.join(root, 'scripts/ide-install-tests.cjs'), path.join(helper, 'tests.cjs'));
	const workspace = path.join(directory, 'workspace'); await mkdir(workspace); await writeFile(path.join(workspace, 'README.md'), '# Disposable installation verification\n');
	const reportPath = path.join(directory, 'result.json');
	const args = ['--user-data-dir', path.join(directory, 'profile'), '--extensions-dir', path.join(directory, 'extensions'), '--disable-telemetry', '--disable-updates', '--skip-release-notes', '--extensionDevelopmentPath', helper, '--extensionTestsPath', path.join(helper, 'tests.cjs'), workspace];
	if (process.platform === 'linux' && process.getuid?.() === 0) { args.push('--no-sandbox'); }
	if (process.env.SOTA_INSTALL_INSPECT) { args.push('--inspect-brk-extensions=9334'); }
	await new Promise((resolve, reject) => {
		let logs = '', finished = false, timedOut = false;
		const child = spawn(binary, args, { cwd: directory, env: { ...env, SOTA_INSTALL_RESULT: reportPath }, stdio: 'pipe', detached: process.platform !== 'win32' });
		child.stdin.end(); child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-64_000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-64_000); });
		const stop = () => { if (!child.pid) { return; } if (process.platform === 'win32') { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000 }); } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { } } };
		const timer = setTimeout(() => { timedOut = true; stop(); }, process.env.SOTA_INSTALL_INSPECT ? 300_000 : 120_000);
		const finish = async error => { if (finished) { return; } finished = true; clearTimeout(timer); stop(); await writeFile(path.join(output, 'installation.log'), logs); error ? reject(error) : resolve(); };
		child.on('error', error => { void finish(error); }); child.on('close', (code, signal) => { void finish(timedOut ? new Error('Installed IDE startup timed out; see installation.log and activation-logs') : code === 0 ? undefined : new Error(`Installed IDE exited ${signal ?? code}; see installation.log`)); });
	});
	const report = JSON.parse(await readFile(reportPath)); assert.equal(report.success, true);
	assert.ok(!report.extensionPath.startsWith(path.join(root, 'extensions')), 'Loaded a development extension instead of the bundled extension');
	await writeFile(path.join(output, 'installation-report.json'), JSON.stringify({ ...report, target, commit: product.commit, ideVersion: product.version, installer: process.env.SOTA_TEST_INSTALLED_APP ? 'system-package' : 'fresh-temporary-install', checkedAssets: manifest.files.map(file => file.name) }, null, 2) + '\n');
	console.log(`Installed IDE activation and bundled native graph checks passed (${target}).`);
} finally {
	const logs = path.join(directory, 'profile/logs');
	try { await cp(logs, path.join(output, 'activation-logs'), { recursive: true }); } catch (error) { if (error.code !== 'ENOENT') { console.warn('Unable to retain activation logs'); } }
	if (mounted) { run('hdiutil', ['detach', mount]); }
	if (uninstaller) { run(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']); }
	await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
