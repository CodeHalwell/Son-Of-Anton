/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared SEA packaging pipeline. The per-platform driver scripts
 * (`package-macos-arm64.mjs`, `package-linux-x64.mjs`,
 * `package-windows-x64.mjs`) call `runPipeline()` with a platform descriptor
 * that captures the bits that differ between targets:
 *
 *   - the Node tarball URL + extraction layout (Mach-O vs ELF vs PE);
 *   - the postject flags (Mach-O segment name is darwin-only);
 *   - whether to codesign the result (macOS only);
 *   - the npm install `--os` / `--cpu` flags that pin the optional-dep
 *     binaries (ripgrep, tree-sitter, etc.) to the target platform;
 *   - the on-disk shim format inside `node_modules/.bin/` (Unix uses
 *     symlinks with `#!/usr/bin/env node` shebangs; Windows uses
 *     `.cmd` files that call `node`).
 *
 * Everything else (esbuild bundling, SEA blob generation, vendor archive,
 * smoke tests) is shared.
 *
 * The pipeline steps are:
 *
 *   1.  Bundle src/seaEntry.ts → dist-bundle/cli.cjs (esbuild).
 *   2.  Vendor: `npm install --prefix dist-bundle/vendor` the upstream
 *       Claude Code + Codex CLIs with `--os <target> --cpu <target>` so the
 *       resulting node_modules/ tree carries the *target* platform's
 *       optional-dep binaries, even when running on a different host.
 *   3.  Rewrite bin shims so they re-enter via the SEA binary's trampoline
 *       mode (`sota --sota-run-node <script>`).
 *   4.  Tar+gzip the vendor tree → dist-bundle/vendor.tgz.
 *   5.  Collect license texts → dist-bundle/THIRD_PARTY_LICENSES.txt.
 *   6.  Emit sea-config.json with the bundle + prompts + vendor.tgz assets.
 *   7.  Generate the SEA blob via a SEA-capable Node (cached under
 *       ~/.cache/sota-sea/<target>/).
 *   8.  Copy the target's Node binary, inject the blob via postject.
 *   9.  Re-sign (Mach-O only).
 *   10. Smoke (only when the target == host).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { withStagedDirectory } from '../../../scripts/staged-directory.mjs';
import { NODE_ARCHIVE_SHA256, verifyArchive } from './node-archive.mjs';
import { vendorInstallArgs, prepareVendorBinaries, vendorBinTarget } from './vendor-target.mjs';
import crossSpawn from 'cross-spawn';
import {
	chmodSync,
	copyFileSync,
	cpSync,
	renameSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	openSync,
	readSync,
	closeSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { packageSmoke } from '../package-smoke.mjs';
import { build as esbuild } from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const CLI_ROOT = resolve(__dirname, '..', '..');
export const REPO_ROOT = resolve(CLI_ROOT, '..');
export const CORE_DIST = resolve(REPO_ROOT, 'son-of-anton-core', 'dist');
export const PROMPTS_DIR = resolve(CORE_DIST, 'agents', 'prompts');
export const OUT_DIR = resolve(CLI_ROOT, 'dist-bundle');
export const CLI_PKG_JSON = resolve(CLI_ROOT, 'package.json');

// Pin the upstream CLIs we vendor. Bump in lockstep with the local
// `claude --version` / `codex --version` you want to ship.
export const CLAUDE_CODE_VERSION = '2.1.138';
export const CODEX_VERSION = '0.153.4';

// Node version used for the SEA host. Bump in lockstep with the esbuild
// `target` field below and with PACKAGING.md.
export const NODE_VERSION = 'v22.23.2';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(step, msg) {
	process.stdout.write(`\x1b[1m[${step}]\x1b[0m ${msg}\n`);
}

function abortPackaging(code = 1) {
	throw new Error(`SEA packaging step failed (exit code ${code})`);
}

// --- Step 1 ---------------------------------------------------------------
async function bundleEntry(bundlePath) {
	log('1/10', `esbuild ${relative(CLI_ROOT, bundlePath)}`);
	const result = await esbuild({
		entryPoints: [resolve(CLI_ROOT, 'src', 'seaEntry.ts')],
		outfile: bundlePath,
		bundle: true,
		platform: 'node',
		target: 'node22',
		format: 'cjs',
		external: [],
		// Prefer the statically linkable ESM distribution over UMD factories with dynamic require.
		mainFields: ['module', 'main'],
		minify: false,
		sourcemap: false,
		keepNames: true,
		logLevel: 'warning',
	});
	if (result.errors.length) {
		console.error('esbuild errors:', result.errors);
		abortPackaging(1);
	}
	const sizeMb = (statSync(bundlePath).size / 1024 / 1024).toFixed(2);
	log('1/10', `bundle written, ${sizeMb} MiB`);
}

// --- Step 2 ---------------------------------------------------------------
function installVendor(vendorDir, target) {
	log('2/10', `npm install vendor CLIs (${target.os}/${target.cpu})`);
	mkdirSync(vendorDir, { recursive: true });
	// Seed an empty package.json so npm doesn't walk up to the parent and
	// pick up unrelated dependencies. `--prefix` alone isn't enough — npm
	// requires a package.json in the prefix dir to install into.
	writeFileSync(
		resolve(vendorDir, 'package.json'),
		JSON.stringify({ name: 'sota-vendor', version: '0.0.0', private: true }, null, 2) + '\n',
	);
	const args = [
		'install',
		'--no-save',
		'--no-package-lock',
		'--no-audit',
		'--no-fund',
		'--prefix', vendorDir,
		...vendorInstallArgs(target, CLAUDE_CODE_VERSION, CODEX_VERSION),
	];
	const r = crossSpawn.sync('npm', args, { stdio: 'inherit', cwd: vendorDir });
	if (r.status !== 0) {
		console.error(`vendor npm install failed: ${r.error?.message ?? r.status}`);
		abortPackaging(r.status ?? 1);
	}
	prepareVendorBinaries(vendorDir, target);
	// Verify the bin shims actually appeared. The optional-dep mechanic
	// silently no-ops on a platform mismatch, so we'd rather fail loudly here
	// than ship a vendor tree that boots into an ENOENT at runtime.
	const binDir = resolve(vendorDir, 'node_modules', '.bin');
	if (!existsSync(binDir)) {
		console.error(`vendor install produced no node_modules/.bin: ${binDir}`);
		abortPackaging(1);
	}
	const binEntries = readdirSync(binDir);
	const missing = ['claude', 'codex'].filter(
		name => !binEntries.includes(name) && !binEntries.includes(`${name}.cmd`) && !binEntries.includes(`${name}.exe`),
	);
	if (missing.length) {
		console.error(`vendor missing bin shims: ${missing.join(', ')}\nGot: ${binEntries.join(', ')}`);
		abortPackaging(1);
	}
}

// --- Step 3 ---------------------------------------------------------------
export function rewriteBinShims(vendorDir, target) {
	log('3/10', `rewrite bin shims (${target.exeFormat})`);
	const binDir = resolve(vendorDir, 'node_modules', '.bin');
	for (const name of ['claude', 'codex']) {
		if (target.exeFormat === 'windows') {
			rewriteWindowsShim(binDir, name, vendorBinTarget(vendorDir, name));
		} else {
			rewriteUnixShim(binDir, name, vendorBinTarget(vendorDir, name));
		}
	}
}

/**
 * On Unix, npm creates `node_modules/.bin/<name>` as a symlink pointing at
 * the package's main bin target. That target is one of two flavours:
 *
 *   - **JavaScript launcher** (e.g. `@openai/codex` → `bin/codex.js` with a
 *     `#!/usr/bin/env node` shebang). The vendored copy needs a Node
 *     interpreter to run, but a SEA binary cannot host arbitrary JS, so we
 *     wrap it in a sh script that re-enters via the SEA trampoline
 *     (`--sota-run-node`).
 *
 *   - **Native binary** (e.g. `@anthropic-ai/claude-code` 2.x →
 *     `bin/claude.exe`, despite the `.exe` suffix it's a Mach-O / ELF /
 *     PE for the host platform shipped via optional-dep packages). The
 *     vendored copy is directly executable; we wrap it in a sh script that
 *     just `exec`s it with the same argv so PATH discovery hits something
 *     marked executable rather than the underlying native binary directly
 *     (which would still work but bypasses our control point).
 */
function rewriteUnixShim(binDir, name, realPath) {
	const shimPath = resolve(binDir, name);
	if (!existsSync(shimPath)) {
		return;
	}
	const relScript = relativeFromBin(binDir, realPath);
	const flavour = classifyBinTarget(realPath);
	rmSync(shimPath, { force: true });
	let wrapper;
	if (flavour === 'native') {
		wrapper = [
			'#!/bin/sh',
			'# Auto-generated by sota packager. Exec native binary directly.',
			'DIR="$(cd "$(dirname "$0")" && pwd)"',
			`exec "$DIR/${relScript}" "$@"`,
			'',
		].join('\n');
	} else {
		wrapper = [
			'#!/bin/sh',
			'# Auto-generated by sota packager. Re-enter through the SEA binary.',
			'DIR="$(cd "$(dirname "$0")" && pwd)"',
			`exec "__SOTA_BIN__" --sota-run-node "$DIR/${relScript}" "$@"`,
			'',
		].join('\n');
	}
	writeFileSync(shimPath, wrapper);
	chmodSync(shimPath, 0o755);
}

/**
 * Tell native binaries from JS launcher scripts by sniffing the first few
 * bytes. We treat ELF (`\x7fELF`), Mach-O (multiple magic numbers), and PE
 * (`MZ`) as native. Anything textual (shebang, plain JS) is treated as a
 * launcher. We also fall back to the `.exe` suffix on Windows, since
 * package authors sometimes name their native binaries `.exe` regardless
 * of host platform.
 */
function classifyBinTarget(filePath) {
	try {
		const descriptor = openSync(filePath, 'r'), head = Buffer.alloc(4);
		try { readSync(descriptor, head, 0, 4, 0); } finally { closeSync(descriptor); }
		// ELF
		if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
			return 'native';
		}
		// Mach-O (32-bit, 64-bit, fat, both endiannesses)
		const magic = head.readUInt32BE(0);
		if (
			magic === 0xfeedface || magic === 0xfeedfacf ||
			magic === 0xcefaedfe || magic === 0xcffaedfe ||
			magic === 0xcafebabe || magic === 0xbebafeca
		) {
			return 'native';
		}
		// PE / MS-DOS
		if (head[0] === 0x4d && head[1] === 0x5a) {
			return 'native';
		}
	} catch {
		// Fall through.
	}
	return 'script';
}

/**
 * On Windows, npm-cmd-shim generates `<name>.cmd` and a sibling
 * extension-less posix shim (for MSYS / git-bash). We rewrite both. As on
 * Unix the underlying bin target may be either a JS launcher (codex) or a
 * native PE (claude 2.x); the wrapper format differs accordingly.
 */
function rewriteWindowsShim(binDir, name, resolvedTarget) {
	const cmdPath = resolve(binDir, `${name}.cmd`);
	const psPath = resolve(binDir, `${name}.ps1`);
	const shPath = resolve(binDir, name);
	// Read each package manifest, even when npm created Unix shims on a cross-build host.
	const script = relative(binDir, resolvedTarget).split(sep).join('\\');
	const flavour = classifyBinTarget(resolvedTarget);
	let cmdWrapper;
	if (flavour === 'native') {
		cmdWrapper = [
			'@ECHO OFF',
			'SETLOCAL DisableDelayedExpansion',
			`"%~dp0\\${script}" %*`,
			'ENDLOCAL',
			'EXIT /B %ERRORLEVEL%',
			'',
		].join('\r\n');
	} else {
		cmdWrapper = [
			'@ECHO OFF',
			'SETLOCAL DisableDelayedExpansion',
			`"__SOTA_BIN__" --sota-run-node "%~dp0\\${script}" %*`,
			'ENDLOCAL',
			'EXIT /B %ERRORLEVEL%',
			'',
		].join('\r\n');
	}
	writeFileSync(cmdPath, cmdWrapper);
	// Best-effort: remove the PowerShell variant (it's the same payload
	// re-implemented in PS, and would otherwise still hit `node` from PATH).
	if (existsSync(psPath)) {
		rmSync(psPath, { force: true });
	}
	if (existsSync(shPath)) {
		rmSync(shPath, { force: true });
		const scriptPosix = script.replace(/\\/g, '/');
		let shWrapper;
		if (flavour === 'native') {
			shWrapper = [
				'#!/bin/sh',
				'# Auto-generated by sota packager. Exec native binary directly.',
				'DIR="$(cd "$(dirname "$0")" && pwd)"',
				`exec "$DIR/${scriptPosix}" "$@"`,
				'',
			].join('\n');
		} else {
			shWrapper = [
				'#!/bin/sh',
				'# Auto-generated by sota packager. Re-enter through the SEA binary.',
				'DIR="$(cd "$(dirname "$0")" && pwd)"',
				`exec "__SOTA_BIN__" --sota-run-node "$DIR/${scriptPosix}" "$@"`,
				'',
			].join('\n');
		}
		writeFileSync(shPath, shWrapper);
		chmodSync(shPath, 0o755);
	}
}

function relativeFromBin(binDir, realPath) {
	const rel = relative(binDir, realPath);
	// Always use POSIX-style separators in the sh wrapper.
	return rel.split('\\').join('/');
}

// --- Step 4 ---------------------------------------------------------------
function archiveVendor(vendorDir, archivePath) {
	log('4/10', `tar+gzip vendor → ${relative(CLI_ROOT, archivePath)}`);
	// Use system `tar` (available on macOS, Linux, and Windows 10+). The
	// runtime extraction step in seaEntry.ts uses the same tool, so we keep
	// the build/runtime symmetric.
	const r = spawnSync('tar', ['-czf', archivePath, '-C', vendorDir, 'node_modules'], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
	if (r.status !== 0) {
		console.error('vendor tar failed');
		abortPackaging(r.status ?? 1);
	}
	const sizeMb = (statSync(archivePath).size / 1024 / 1024).toFixed(2);
	log('4/10', `vendor.tgz ${sizeMb} MiB`);
}

// --- Step 5 ---------------------------------------------------------------
function collectLicenses(vendorDir, licensesPath) {
	log('5/10', `collect licenses → ${relative(CLI_ROOT, licensesPath)}`);
	const nodeModules = resolve(vendorDir, 'node_modules');
	if (!existsSync(nodeModules)) {
		writeFileSync(licensesPath, '# No vendored packages found.\n');
		return;
	}
	const out = [
		'# Third-party licenses bundled with sota',
		'',
		'This file is auto-generated by the sota packager. It lists licenses for',
		`packages bundled inside the vendor archive (claude-code@${CLAUDE_CODE_VERSION},`,
		`codex@${CODEX_VERSION}, plus all transitive runtime deps).`,
		'',
	];
	const pkgs = walkPackages(nodeModules);
	for (const pkgDir of pkgs) {
		const pj = safeReadJson(resolve(pkgDir, 'package.json'));
		if (!pj?.name) {
			continue;
		}
		const licenseText = readFirstExisting(pkgDir, [
			'LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License', 'License.md',
			'LICENCE', 'LICENCE.md', 'LICENCE.txt',
		]);
		out.push('## ' + pkgDir.slice(nodeModules.length + 1));
		out.push(`Name:    ${pj.name}`);
		out.push(`Version: ${pj.version ?? 'unknown'}`);
		out.push(`License: ${pj.license ?? pj.licenses ?? 'unknown'}`);
		out.push('');
		if (licenseText) {
			out.push(licenseText.trimEnd());
		} else {
			out.push('(no LICENSE file shipped in the package)');
		}
		out.push('', '---', '');
	}
	writeFileSync(licensesPath, out.join('\n') + '\n');
}

function walkPackages(rootNodeModules) {
	const results = [];
	function walk(dir) {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (!ent.isDirectory() && !ent.isSymbolicLink()) {
				continue;
			}
			const full = resolve(dir, ent.name);
			if (ent.name.startsWith('@')) {
				walk(full);
				continue;
			}
			if (ent.name === '.bin' || ent.name === '.package-lock.json') {
				continue;
			}
			if (existsSync(resolve(full, 'package.json'))) {
				results.push(full);
			}
			const nested = resolve(full, 'node_modules');
			if (existsSync(nested)) {
				walk(nested);
			}
		}
	}
	walk(rootNodeModules);
	return results;
}

function safeReadJson(path) {
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return undefined;
	}
}

function readFirstExisting(dir, names) {
	for (const name of names) {
		const p = resolve(dir, name);
		if (existsSync(p)) {
			try {
				return readFileSync(p, 'utf8');
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

// --- Step 6 ---------------------------------------------------------------
function writeSeaConfig(target, paths) {
	const promptFiles = readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.prompt.md'));
	const assets = Object.fromEntries(
		promptFiles.map(f => [f, join(PROMPTS_DIR, f)]),
	);
	assets['vendor.tgz'] = paths.vendorArchive;
	const cfg = {
		main: relative(CLI_ROOT, paths.bundle),
		output: relative(CLI_ROOT, paths.blob),
		disableExperimentalSEAWarning: true,
		useSnapshot: false,
		// V8 code cache is keyed to the producing platform. Cross-builds
		// (e.g. linux-x64 from a darwin-arm64 host) crash on startup if we
		// embed a host-built cache; keep useCodeCache off for them and only
		// enable it when we're building for the running platform.
		useCodeCache: target.matchesHost,
		assets,
	};
	writeFileSync(paths.seaConfig, JSON.stringify(cfg, null, 2) + '\n');
	log('6/10', `sea-config.json written (${promptFiles.length} prompts + vendor.tgz, useCodeCache=${cfg.useCodeCache})`);
}

// --- Step 7 ---------------------------------------------------------------
/**
 * Ensure two Node binaries are available:
 *
 *   - **producer**: a SEA-capable Node that runs on the *host*. Used to
 *     generate the SEA blob (`node --experimental-sea-config …`). The
 *     producer and target use the same pinned release; code caches are
 *     disabled for cross-platform builds.
 *   - **target**: the actual Node binary that becomes `dist-bundle/<bin>`
 *     after blob injection. Must match the target OS/CPU.
 *
 * For host builds these are usually the same binary; for cross builds they
 * are different and both are cached under `~/.cache/sota-sea/`.
 */
async function ensureNodeBinaries(target) {
	const producerCacheKey = describeHost();
	const producerNode = await ensureNodeForPlatform({
		id: producerCacheKey.id,
		nodeArchiveName: producerCacheKey.nodeArchiveName,
		nodeDir: producerCacheKey.nodeDir,
		nodeExeRelative: producerCacheKey.nodeExeRelative,
		isProducer: true,
	});
	const targetNode = target.matchesHost
		? producerNode
		: await ensureNodeForPlatform({ ...target, isProducer: false });
	return { producerNode, targetNode };
}

function describeHost() {
	if (process.platform === 'darwin' && process.arch === 'arm64') {
		return {
			id: 'darwin-arm64-host',
			nodeArchiveName: `node-${NODE_VERSION}-darwin-arm64.tar.gz`,
			nodeDir: `node-${NODE_VERSION}-darwin-arm64`,
			nodeExeRelative: 'bin/node',
		};
	}
	if (process.platform === 'darwin' && process.arch === 'x64') {
		return {
			id: 'darwin-x64-host',
			nodeArchiveName: `node-${NODE_VERSION}-darwin-x64.tar.gz`,
			nodeDir: `node-${NODE_VERSION}-darwin-x64`,
			nodeExeRelative: 'bin/node',
		};
	}
	if (process.platform === 'linux' && process.arch === 'x64') {
		return {
			id: 'linux-x64-host',
			nodeArchiveName: `node-${NODE_VERSION}-linux-x64.tar.xz`,
			nodeDir: `node-${NODE_VERSION}-linux-x64`,
			nodeExeRelative: 'bin/node',
		};
	}
	if (process.platform === 'linux' && process.arch === 'arm64') {
		return {
			id: 'linux-arm64-host',
			nodeArchiveName: `node-${NODE_VERSION}-linux-arm64.tar.xz`,
			nodeDir: `node-${NODE_VERSION}-linux-arm64`,
			nodeExeRelative: 'bin/node',
		};
	}
	if (process.platform === 'win32' && process.arch === 'x64') {
		return {
			id: 'win-x64-host',
			nodeArchiveName: `node-${NODE_VERSION}-win-x64.zip`,
			nodeDir: `node-${NODE_VERSION}-win-x64`,
			nodeExeRelative: 'node.exe',
		};
	}
	console.error(`unsupported host platform: ${process.platform}/${process.arch}`);
	abortPackaging(1);
}

async function ensureNodeForPlatform(spec) {
	const cacheRoot = resolve(homedir(), '.cache', 'sota-sea');
	const targetDir = resolve(cacheRoot, spec.nodeDir);
	const expected = NODE_ARCHIVE_SHA256[spec.nodeArchiveName];
	if (!expected) { throw new Error(`No pinned checksum for ${spec.nodeArchiveName}`); }
	mkdirSync(cacheRoot, { recursive: true });
	const archivePath = resolve(cacheRoot, spec.nodeArchiveName);
	let verified = false;
	if (existsSync(archivePath)) {
		try { verifyArchive(archivePath, expected); verified = true; }
		catch { log('7a/10', 'Cached Node archive failed verification; downloading a fresh copy'); }
	}
	if (!verified) {
		const temporary = mkdtempSync(resolve(cacheRoot, '.node-download-'));
		try {
			const download = resolve(temporary, spec.nodeArchiveName);
			const url = `https://nodejs.org/dist/${NODE_VERSION}/${spec.nodeArchiveName}`;
			log('7a/10', `downloading official Node ${NODE_VERSION} (${spec.id})`);
			const result = spawnSync('curl', ['--fail', '--location', '--proto', '=https', '--connect-timeout', '15', '--max-time', '300', '--retry', '2', '--output', download, url], { stdio: 'inherit' });
			if (result.status !== 0) { throw new Error(`Node download failed (${result.error?.message ?? result.status})`); }
			verifyArchive(download, expected);
			renameSync(download, archivePath);
		} finally { rmSync(temporary, { recursive: true, force: true }); }
	}
	// Re-extract verified bytes rather than trusting an old or modified cached executable.
	await withStagedDirectory(targetDir, async staged => {
		const temporary = mkdtempSync(resolve(cacheRoot, '.node-unpack-'));
		try {
			extractNodeArchive(archivePath, temporary, spec);
			const unpacked = resolve(temporary, spec.nodeDir);
			if (!existsSync(resolve(unpacked, spec.nodeExeRelative))) { throw new Error('Verified Node archive is missing its executable'); }
			for (const entry of readdirSync(unpacked)) { cpSync(resolve(unpacked, entry), resolve(staged, entry), { recursive: true, verbatimSymlinks: true }); }
			if (!hasFuse(resolve(staged, spec.nodeExeRelative))) { throw new Error('Pinned Node executable does not support SEA'); }
		} finally { rmSync(temporary, { recursive: true, force: true }); }
	});
	return resolve(targetDir, spec.nodeExeRelative);
}

function extractNodeArchive(archivePath, destDir, target) {
	if (target.nodeArchiveName.endsWith('.zip')) {
		// Windows ships bsdtar with ZIP support; a separate Unix unzip is not required.
		const r = process.platform === 'win32'
			? spawnSync('tar.exe', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' })
			: spawnSync('unzip', ['-q', '-o', archivePath, '-d', destDir], { stdio: 'inherit' });
		if (r.status !== 0) {
			console.error(`Windows Node archive extraction failed: ${r.error?.message ?? r.status}`);
			abortPackaging(r.status ?? 1);
		}
		return;
	}
	if (target.nodeArchiveName.endsWith('.tar.xz')) {
		const r = spawnSync('tar', ['-xJf', archivePath, '-C', destDir], { stdio: 'inherit' });
		if (r.status !== 0) {
			console.error('tar -xJ failed (xz not available?)');
			abortPackaging(r.status ?? 1);
		}
		return;
	}
	const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' });
	if (r.status !== 0) {
		console.error('tar -xz failed');
		abortPackaging(r.status ?? 1);
	}
}

function hasFuse(binary) {
	try {
		const content = readFileSync(binary);
		return content.indexOf(SEA_FUSE) !== -1;
	} catch {
		return false;
	}
}

function generateBlob(producerNode, seaConfig, blobPath) {
	log('7/10', `generate SEA blob via ${relative(homedir(), producerNode)}`);
	const r = spawnSync(producerNode, ['--experimental-sea-config', seaConfig], {
		stdio: 'inherit',
		cwd: CLI_ROOT,
	});
	if (r.status !== 0) {
		console.error('SEA blob generation failed');
		abortPackaging(r.status ?? 1);
	}
	if (!existsSync(blobPath)) {
		console.error(`blob missing at ${blobPath}`);
		abortPackaging(1);
	}
}

// --- Step 8 ---------------------------------------------------------------
function copyNodeBinary(target, paths) {
	log('8a/10', `copy ${target.id} Node → ${relative(CLI_ROOT, paths.binary)}`);
	copyFileSync(paths.sourceNode, paths.binary);
	// Some Homebrew installs ship 0555; postject needs to write.
	try {
		chmodSync(paths.binary, 0o755);
	} catch {
		// Windows ignores chmod; postject doesn't care.
	}
}

function inject(target, paths) {
	log('8b/10', 'postject inject');
	const postjectArgs = [
		'--yes',
		'postject',
		paths.binary,
		'NODE_SEA_BLOB',
		paths.blob,
		'--sentinel-fuse', SEA_FUSE,
		'--overwrite',
	];
	if (target.exeFormat === 'macho') {
		postjectArgs.push('--macho-segment-name', 'NODE_SEA');
	}
	const r = crossSpawn.sync('npx', postjectArgs, { stdio: 'inherit', cwd: CLI_ROOT });
	if (r.status !== 0) {
		console.error(`postject failed: ${r.error?.message ?? r.status}`);
		abortPackaging(r.status ?? 1);
	}
}

// --- Step 9 ---------------------------------------------------------------
function reSign(target, paths) {
	if (target.exeFormat !== 'macho') {
		log('9/10', `skip codesign (${target.exeFormat})`);
		// Windows binaries are still subject to Authenticode signing further
		// down; ELF binaries are left unsigned by convention.
		if (target.exeFormat === 'windows') {
			signBinary({ target, binaryPath: paths.binary });
		}
		return;
	}
	if (!target.matchesHost) {
		log('9/10', 'skip codesign (cross-build; sign on the macOS host before distribution)');
		return;
	}
	log('9/10', 'codesign --remove-signature && --sign -');
	const strip = spawnSync('codesign', ['--remove-signature', paths.binary], { stdio: 'inherit' });
	if (strip.status !== 0) {
		console.error('codesign --remove-signature failed');
		abortPackaging(strip.status ?? 1);
	}
	const sign = spawnSync('codesign', ['--sign', '-', paths.binary], { stdio: 'inherit' });
	if (sign.status !== 0) {
		console.error('codesign --sign - failed');
		abortPackaging(sign.status ?? 1);
	}
	// After ad-hoc signing, optionally re-sign with a real Developer ID and
	// notarise. Both steps are gated on env vars and no-op without them, so
	// local dev never has to think about signing.
	signBinary({ target, binaryPath: paths.binary });
}

// --- Step 9b: production code signing -------------------------------------
/**
 * Optional production signing pass. Invoked from the pipeline after the
 * ad-hoc Mach-O signing / Windows binary is produced; also exported so the
 * release workflow can call the per-platform helpers directly.
 *
 * Behaviour is entirely env-var driven:
 *
 *   - **macOS** (Mach-O binaries): if `SOTA_MACOS_SIGNING_IDENTITY` is set,
 *     re-sign with that Developer ID; if the three `SOTA_MACOS_NOTARY_KEY_*`
 *     vars are also set, notarise and verify. Either step is a no-op when its
 *     env vars are absent.
 *   - **Windows** (PE binaries): if `SOTA_WINDOWS_SIGNING_CERT` and a
 *     password (either `SOTA_WINDOWS_SIGNING_PASSWORD` or the contents of
 *     `SOTA_WINDOWS_SIGNING_CERT_PASSWORD_FILE`) are set, invoke `signtool`
 *     to apply an Authenticode signature with an RFC3161 timestamp.
 *     Configured signing fails closed when the signing tool is unavailable.
 *
 * @param {{ target: object, binaryPath: string }} args
 */
export function signBinary({ target, binaryPath }) {
	if (target.exeFormat === 'macho') {
		signMacOs(binaryPath);
		return;
	}
	if (target.exeFormat === 'windows') {
		signWindows(binaryPath);
		return;
	}
	// ELF / other: nothing to do.
}

/**
 * Re-sign a Mach-O binary with a real Developer ID and (optionally) notarise.
 * Both phases are gated on env vars and no-op without them.
 *
 *   - `SOTA_MACOS_SIGNING_IDENTITY` — common name of the Developer ID
 *     Application identity in the login keychain (e.g.
 *     "Developer ID Application: Acme Corp (TEAMID)").
 *   - `SOTA_MACOS_NOTARY_KEY_ID`, `SOTA_MACOS_NOTARY_KEY_ISSUER`,
 *     `SOTA_MACOS_NOTARY_KEY_PATH` — App Store Connect API key triple used
 *     by `xcrun notarytool`. All three must be present to trigger
 *     notarisation; we zip the binary, submit, wait, then verify.
 */
export function signMacOs(binaryPath, options = {}) {
	const env = options.env ?? process.env;
	const execute = options.spawnSync ?? spawnSync;
	const identity = env.SOTA_MACOS_SIGNING_IDENTITY;
	const notaryKeys = ['SOTA_MACOS_NOTARY_KEY_ID', 'SOTA_MACOS_NOTARY_KEY_ISSUER', 'SOTA_MACOS_NOTARY_KEY_PATH'];
	const configured = notaryKeys.filter(key => env[key]);
	if (configured.length && (configured.length !== notaryKeys.length || !identity)) {
		throw new Error('Notarization requires a signing identity and all three notary key settings');
	}
	if (env.SOTA_REQUIRE_SIGNING === 'true' && (!identity || !configured.length)) {
		throw new Error('Developer ID signing and notarization are required for this release');
	}
	if (!identity) {
		log('9b/10', 'skip Developer ID signing (SOTA_MACOS_SIGNING_IDENTITY unset)');
		return;
	}
	const run = (command, args) => {
		const result = execute(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 31 * 60_000 });
		// Never interpolate command arguments: these can contain credential paths.
		if (result.error || result.status !== 0) { throw new Error(`${command} failed during CLI signing`); }
		return result.stdout;
	};
	const entitlements = resolve(CLI_ROOT, 'scripts/macos-entitlements.plist');
	run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--entitlements', entitlements,
		...(env.SOTA_MACOS_SIGNING_KEYCHAIN ? ['--keychain', env.SOTA_MACOS_SIGNING_KEYCHAIN] : []), '--sign', identity, binaryPath]);
	run('codesign', ['--verify', '--strict', binaryPath]);
	if (!configured.length) {
		log('9b/10', 'Developer ID signed; notarization is not configured');
		return;
	}
	const directory = mkdtempSync(join(tmpdir(), 'sota-cli-notary-'));
	try {
		const zipPath = join(directory, 'sota.zip');
		run('ditto', ['-c', '-k', '--keepParent', binaryPath, zipPath]);
		const response = JSON.parse(run('xcrun', [
			'notarytool', 'submit', zipPath, '--key', env.SOTA_MACOS_NOTARY_KEY_PATH,
			'--key-id', env.SOTA_MACOS_NOTARY_KEY_ID, '--issuer', env.SOTA_MACOS_NOTARY_KEY_ISSUER,
			'--wait', '--timeout', '30m', '--output-format', 'json',
		]));
		if (response.status !== 'Accepted') { throw new Error('Apple did not accept CLI notarization'); }
		// Raw executables cannot carry stapled tickets. Verify their notarized
		// code requirement; Gatekeeper retrieves the ticket online on first use.
		run('codesign', ['--verify', '--strict', '-R=notarized', binaryPath]);
		log('9b/10', 'Developer ID signature and notarization verified');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/**
 * Apply an Authenticode signature to a Windows PE binary. No-ops silently
 * when:
 *   - `SOTA_WINDOWS_SIGNING_CERT` is unset (no cert configured); or
 *   - production signing is not required. Configured signing never silently skips.
 *
 * Required env vars (when signing):
 *   - `SOTA_WINDOWS_SIGNING_CERT` — path to a .pfx (PKCS#12) file.
 *   - `SOTA_WINDOWS_SIGNING_PASSWORD` — password for the .pfx, OR
 *   - `SOTA_WINDOWS_SIGNING_CERT_PASSWORD_FILE` — path to a file whose
 *     contents are the password. The file form is preferred in CI because
 *     it keeps the password out of the environment; signtool still receives it in argv.
 */
export function signWindows(binaryPath, options = {}) {
	const env = options.env ?? process.env;
	const execute = options.spawnSync ?? spawnSync;
	const certPath = env.SOTA_WINDOWS_SIGNING_CERT;
	if (!certPath) {
		if (env.SOTA_REQUIRE_SIGNING === 'true' || env.SOTA_WINDOWS_SIGNING_PASSWORD || env.SOTA_WINDOWS_SIGNING_CERT_PASSWORD_FILE) {
			throw new Error('Windows signing requires a certificate');
		}
		log('9b/10', 'skip Authenticode signing (SOTA_WINDOWS_SIGNING_CERT unset)');
		return;
	}
	let password = env.SOTA_WINDOWS_SIGNING_PASSWORD;
	if (!password && env.SOTA_WINDOWS_SIGNING_CERT_PASSWORD_FILE) {
		password = readFileSync(env.SOTA_WINDOWS_SIGNING_CERT_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
	}
	if (!password) { throw new Error('Windows signing requires a certificate password'); }
	let signtool = env.SOTA_WINDOWS_SIGNTOOL;
	if (!signtool && execute('where', ['signtool'], { stdio: 'pipe' }).status === 0) { signtool = 'signtool'; }
	if (!signtool && env['ProgramFiles(x86)']) {
		const kits = join(env['ProgramFiles(x86)'], 'Windows Kits/10/bin');
		if (existsSync(kits)) {
			for (const version of readdirSync(kits).filter(name => /^10\./.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
				const candidate = join(kits, version, 'x64/signtool.exe');
				if (existsSync(candidate)) { signtool = candidate; break; }
			}
		}
	}
	if (!signtool) { throw new Error('Windows signing is configured but signtool is unavailable'); }
	const run = args => {
		const result = execute(signtool, args, { stdio: 'pipe', timeout: 120000 });
		if (result.error || result.status !== 0) { throw new Error('Windows code signing or verification failed'); }
	};
	run(['sign', '/f', certPath, '/p', password, '/tr', 'http://timestamp.digicert.com', '/td', 'sha256', '/fd', 'sha256', binaryPath]);
	run(['verify', '/pa', binaryPath]);
	log('9b/10', 'Authenticode signature verified');
}

// --- Step 10 --------------------------------------------------------------
async function smoke(target, paths) {
	const sizeMb = (statSync(paths.binary).size / 1024 / 1024).toFixed(2);
	if (!target.matchesHost) {
		log('10/10', `skip smoke (cross-build); produced ${relative(CLI_ROOT, paths.binary)} (${sizeMb} MiB)`);
		return;
	}
	log('10/10', `smoke ${relative(CLI_ROOT, paths.binary)} --version`);
	const r = spawnSync(paths.binary, ['--version'], { stdio: 'pipe' });
	const out = (r.stdout?.toString() ?? '') + (r.stderr?.toString() ?? '');
	process.stdout.write(out);
	if (r.status !== 0) {
		console.error('smoke test failed');
		abortPackaging(r.status ?? 1);
	}
	await packageSmoke(paths.binary);
	log('10/10', 'Candidate smoke checks passed');
}

// --- Driver --------------------------------------------------------------
export async function runPipeline(target, { outputDir = process.env.SOTA_CLI_PACKAGE_OUTPUT || OUT_DIR } = {}) {
	if (!existsSync(PROMPTS_DIR)) {
		console.error(`prompts dir missing: ${PROMPTS_DIR}\nRun 'npm run build' in son-of-anton-core first.`);
		abortPackaging(1);
	}
	await withStagedDirectory(outputDir, async staged => {
		const paths = {
			bundle: resolve(staged, 'cli.cjs'),
			seaConfig: resolve(staged, 'sea-config.json'),
			blob: resolve(staged, target.blobName),
			binary: resolve(staged, target.binaryName),
			vendorDir: resolve(staged, 'vendor'),
			vendorArchive: resolve(staged, 'vendor.tgz'),
			licenses: resolve(staged, 'THIRD_PARTY_LICENSES.txt'),
			sourceNode: '',
		};
		await bundleEntry(paths.bundle);
		installVendor(paths.vendorDir, target);
		rewriteBinShims(paths.vendorDir, target);
		archiveVendor(paths.vendorDir, paths.vendorArchive);
		collectLicenses(paths.vendorDir, paths.licenses);
		writeSeaConfig(target, paths);
		const { producerNode, targetNode } = await ensureNodeBinaries(target);
		paths.sourceNode = targetNode;
		generateBlob(producerNode, paths.seaConfig, paths.blob);
		// This configuration contains staging paths and is not a reusable release artifact.
		rmSync(paths.seaConfig);
		copyNodeBinary(target, paths);
		inject(target, paths);
		reSign(target, paths);
		// Clean the unpacked vendor directory now that it's archived — keeps
		// dist-bundle/ smaller and avoids developers shipping the loose tree
		// alongside the binary by accident.
		rmSync(paths.vendorDir, { recursive: true, force: true });
		await smoke(target, paths);
	});
	log('done', `CLI artifacts: ${outputDir}`);
}
