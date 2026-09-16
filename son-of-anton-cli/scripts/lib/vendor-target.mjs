/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { openSync, readSync, closeSync, readFileSync, copyFileSync, linkSync, chmodSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';

const packages = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };

export function vendorInstallArgs(target, claudeVersion, codexVersion) {
	const platform = `${target.os}-${target.cpu}`;
	if (!['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'].includes(platform)) {
		throw new Error(`Unsupported vendor target: ${platform}`);
	}
	return [
		'--ignore-scripts', '--include=optional', '--os', target.os, '--cpu', target.cpu,
		// npm 10's required-dependency check ignores os/cpu overrides. Reify
		// still selects target optional packages; verifyNativeTarget validates
		// the actual binaries before any candidate can be published.
		...(target.os !== process.platform || target.cpu !== process.arch ? ['--force'] : []),
		...(target.os === 'linux' ? ['--libc', 'glibc'] : []),
		`${packages.claude}@${claudeVersion}`, `${packages.codex}@${codexVersion}`,
		// Required direct dependencies make npm fail if a target download fails.
		`${packages.claude}-${platform}@${claudeVersion}`,
		`${packages.codex}-${platform}@npm:${packages.codex}@${codexVersion}-${platform}`,
	];
}

export function vendorBinTarget(vendorDir, name) {
	const root = resolve(vendorDir, 'node_modules', packages[name]);
	const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
	const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[name];
	if (typeof bin !== 'string' || !bin) { throw new Error(`Missing ${name} bin in package manifest`); }
	const path = resolve(root, bin), rel = relative(root, path);
	if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) { throw new Error(`Invalid ${name} bin path`); }
	return path;
}

export function verifyNativeTarget(path, target) {
	const descriptor = openSync(path, 'r'), header = Buffer.alloc(4096);
	let size;
	try { size = readSync(descriptor, header, 0, header.length, 0); } finally { closeSync(descriptor); }
	let matches = false;
	if (size >= 20 && target.os === 'linux' && header.readUInt32BE(0) === 0x7f454c46) {
		matches = header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === (target.cpu === 'x64' ? 62 : 183);
	} else if (size >= 8 && target.os === 'darwin' && header.readUInt32LE(0) === 0xfeedfacf) {
		matches = header.readUInt32LE(4) === (target.cpu === 'x64' ? 0x01000007 : 0x0100000c);
	} else if (size >= 64 && target.os === 'win32' && header.readUInt16LE(0) === 0x5a4d) {
		const offset = header.readUInt32LE(60);
		matches = offset <= size - 6 && header.readUInt32LE(offset) === 0x00004550 && header.readUInt16LE(offset + 4) === (target.cpu === 'x64' ? 0x8664 : 0xaa64);
	}
	if (!matches) { throw new Error(`Vendor binary does not match ${target.os}/${target.cpu}: ${path}`); }
}

export function prepareVendorBinaries(vendorDir, target) {
	const platform = `${target.os}-${target.cpu}`, extension = target.os === 'win32' ? '.exe' : '';
	const claude = resolve(vendorDir, 'node_modules', `${packages.claude}-${platform}`, `claude${extension}`);
	verifyNativeTarget(claude, target);
	// Upstream postinstall detects process.platform, which is the build host.
	// Place the selected target ourselves, replacing its placeholder executable.
	const destination = vendorBinTarget(vendorDir, 'claude');
	rmSync(destination, { force: true });
	try { linkSync(claude, destination); } catch { copyFileSync(claude, destination); }
	chmodSync(destination, 0o755);
	const architecture = target.cpu === 'x64' ? 'x86_64' : 'aarch64';
	const system = { darwin: 'apple-darwin', linux: 'unknown-linux-musl', win32: 'pc-windows-msvc' }[target.os];
	const codex = resolve(vendorDir, 'node_modules', `${packages.codex}-${platform}`, 'vendor', `${architecture}-${system}`);
	verifyNativeTarget(resolve(codex, 'bin', `codex${extension}`), target);
	verifyNativeTarget(resolve(codex, 'bin', `codex-code-mode-host${extension}`), target);
	verifyNativeTarget(resolve(codex, 'codex-path', `rg${extension}`), target);
}
