/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { readFile, writeFile, mkdir, cp, readdir, stat, symlink, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const product = JSON.parse(await readFile(path.join(root, 'product.json')));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json')));
const target = `${process.platform}-${process.arch}`;
if (!['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].includes(target)) { throw new Error(`Unsupported native IDE package target: ${target}`); }
const source = path.resolve(root, '..', `Son of Anton-${target}`);
const output = path.join(root, '.build/ide-release', target);
await mkdir(output, { recursive: true });
const run = (command, args, options = {}) => {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit', ...options });
	if (result.error || result.status !== 0) { throw new Error(`${path.basename(command)} failed (${result.status}): ${result.error?.message ?? ''}`); }
	return result.stdout?.trim();
};
const app = process.platform === 'darwin' ? path.join(source, `${product.nameLong}.app`) : source;
const resources = process.platform === 'darwin' ? path.join(app, 'Contents/Resources/app') : path.join(app, 'resources/app');
const packagedProduct = JSON.parse(await readFile(path.join(resources, 'product.json')));
if (packagedProduct.version !== pkg.version) { throw new Error('Packaged IDE version differs from the source version'); }
const prefix = `son-of-anton-${pkg.version}-${target}`;
const assets = [];
if (process.platform === 'darwin') {
	// Sign the complete nested application before putting it into either archive.
	run(process.execPath, ['scripts/sign-ide.mjs', app]);
	const zip = `${prefix}.zip`;
	run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, path.join(output, zip)]); assets.push(zip);
	const staging = path.join(output, 'dmg-content');
	await mkdir(staging); await cp(app, path.join(staging, path.basename(app)), { recursive: true, verbatimSymlinks: true });
	await symlink('/Applications', path.join(staging, 'Applications'));
	const dmg = `${prefix}.dmg`;
	try {
		const args = ['create', '-volname', product.nameLong, '-srcfolder', staging, '-ov', '-format', 'UDZO', path.join(output, dmg)];
		for (let attempt = 1; ; attempt++) {
			const result = spawnSync('hdiutil', args, { cwd: root, encoding: 'utf8', timeout: 300_000 });
			if (result.stdout) { process.stdout.write(result.stdout); }
			if (result.stderr) { process.stderr.write(result.stderr); }
			if (!result.error && result.status === 0) { assets.push(dmg); break; }
			if (result.error || attempt >= 3 || !/Resource busy/i.test(result.stderr ?? '')) { throw new Error(`Disk image creation failed: ${result.error?.message ?? result.stderr}`); }
			console.warn(`Disk image tool is busy; retrying (${attempt}/2).`);
			await new Promise(resolve => setTimeout(resolve, attempt * 5000));
		}
	}
	finally { await rm(staging, { recursive: true, force: true }); }
	if (process.env.SOTA_MACOS_NOTARY_KEY_PATH) {
		run('xcrun', ['notarytool', 'submit', path.join(output, dmg), '--key', process.env.SOTA_MACOS_NOTARY_KEY_PATH, '--key-id', process.env.MACOS_NOTARY_KEY_ID, '--issuer', process.env.MACOS_NOTARY_KEY_ISSUER, '--wait', '--timeout', '30m']);
		run('xcrun', ['stapler', 'staple', path.join(output, dmg)]);
	}
} else if (process.platform === 'win32') {
	run(process.execPath, ['node_modules/gulp/bin/gulp.js', `vscode-win32-${process.arch}-inno-updater`]);
	run(process.execPath, ['scripts/sign-ide.mjs', source]);
	run(process.execPath, ['node_modules/gulp/bin/gulp.js', `vscode-win32-${process.arch}-user-setup`]);
	const setupDirectory = path.join(root, `.build/win32-${process.arch}/user-setup`);
	const setups = (await readdir(setupDirectory)).filter(file => file.endsWith('.exe'));
	if (setups.length !== 1) { throw new Error('Expected exactly one Windows user installer'); }
	const setup = `${prefix}-setup.exe`; await cp(path.join(setupDirectory, setups[0]), path.join(output, setup));
	run(process.execPath, ['scripts/sign-ide.mjs', path.join(output, setup)]); assets.push(setup);
	const zip = `${prefix}.zip`; run('7z', ['a', '-tzip', path.join(output, zip), '.'], { cwd: source }); assets.push(zip);
} else {
	const tar = `${prefix}.tar.gz`; run('tar', ['-czf', path.join(output, tar), '-C', path.dirname(source), path.basename(source)]); assets.push(tar);
	// Generate dependencies from every shipped ELF executable/native addon on this native runner.
	const staging = path.join(output, 'deb-content'); await mkdir(staging);
	const application = path.join(staging, `usr/share/${product.applicationName}`);
	await cp(source, application, { recursive: true, verbatimSymlinks: true });
	await mkdir(path.join(staging, 'usr/bin'), { recursive: true });
	await symlink(`../share/${product.applicationName}/bin/${product.applicationName}`, path.join(staging, `usr/bin/${product.applicationName}`));
	await mkdir(path.join(staging, 'usr/share/applications'), { recursive: true });
	await mkdir(path.join(staging, 'usr/share/pixmaps'), { recursive: true });
	await cp(path.join(root, 'resources/linux/code.png'), path.join(staging, `usr/share/pixmaps/${product.linuxIconName}.png`));
	for (const [template, filename] of [['code.desktop', `${product.applicationName}.desktop`], ['code-url-handler.desktop', `${product.applicationName}-url-handler.desktop`]]) {
		let desktop = await readFile(path.join(root, 'resources/linux', template), 'utf8');
		for (const [key, value] of Object.entries({ NAME_LONG: product.nameLong, NAME_SHORT: product.nameShort, NAME: product.applicationName, EXEC: `/usr/share/${product.applicationName}/${product.applicationName}`, ICON: product.linuxIconName, URLPROTOCOL: product.urlProtocol })) { desktop = desktop.replaceAll(`@@${key}@@`, value); }
		await writeFile(path.join(staging, 'usr/share/applications', filename), desktop);
	}
	const elf = [], libraries = new Set([application]);
	async function collect(directory) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) { await collect(file); }
			else if (entry.isFile() && (/\.(node|so(?:\.\d+)*)$/.test(entry.name) || (await stat(file)).mode & 0o111)) {
				const data = await readFile(file); if (!data.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) { continue; }
				elf.push(file); libraries.add(directory);
			}
		}
	}
	await collect(application);
	await mkdir(path.join(staging, 'debian')); await writeFile(path.join(staging, 'debian/control'), `Source: ${product.applicationName}\nSection: editors\nPriority: optional\nMaintainer: Son of Anton Contributors <noreply@github.com>\n\nPackage: ${product.applicationName}\nArchitecture: amd64\nDescription: Son of Anton IDE\n`);
	const generated = run('dpkg-shlibdeps', ['-O', '--ignore-missing-info', ...[...libraries].map(directory => `-l${directory}`), ...elf.map(file => `-e${file}`)], { cwd: staging, stdio: 'pipe' });
	const dependencies = generated.split('\n').find(line => line.startsWith('shlibs:Depends='))?.slice('shlibs:Depends='.length);
	if (!dependencies) { throw new Error('No runtime dependencies were generated'); }
	await rm(path.join(staging, 'debian'), { recursive: true }); await mkdir(path.join(staging, 'DEBIAN'));
	await writeFile(path.join(staging, 'DEBIAN/control'), `Package: ${product.applicationName}\nVersion: ${pkg.version}\nArchitecture: amd64\nMaintainer: Son of Anton Contributors <noreply@github.com>\nSection: editors\nPriority: optional\nDepends: ${dependencies}, ca-certificates, libgtk-3-0, libnss3, xdg-utils\nHomepage: https://github.com/CodeHalwell/Son-Of-Anton\nDescription: Son of Anton IDE\n AI-assisted development environment with bundled code graph.\n`);
	await writeFile(path.join(staging, 'DEBIAN/postinst'), '#!/bin/sh\nset -e\nupdate-desktop-database /usr/share/applications || true\n'); await chmod(path.join(staging, 'DEBIAN/postinst'), 0o755);
	await chmod(path.join(application, 'chrome-sandbox'), 0o4755);
	const deb = `${prefix}.deb`;
	try { run('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', staging, path.join(output, deb)]); assets.push(deb); }
	finally { await rm(staging, { recursive: true, force: true }); }
}
const files = await Promise.all(assets.map(async name => { const bytes = await readFile(path.join(output, name)); return { name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }));
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, product: product.nameLong, ideVersion: pkg.version, commit: packagedProduct.commit, target, createdAt: new Date().toISOString(), signing: process.platform === 'darwin' ? process.env.MACOS_SIGNING_IDENTITY ? process.env.MACOS_NOTARY_KEY_BASE64 ? 'developer-id-notarized' : 'developer-id' : 'ad-hoc' : process.platform === 'win32' && process.env.WINDOWS_SIGNING_CERT_BASE64 ? 'authenticode' : 'unsigned', files }, null, 2) + '\n');
await writeFile(path.join(output, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.name}\n`).join(''));
console.log(`IDE installers: ${output}`);
