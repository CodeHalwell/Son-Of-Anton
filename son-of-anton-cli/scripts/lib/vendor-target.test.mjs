/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vendorInstallArgs, prepareVendorBinaries, verifyNativeTarget } from './vendor-target.mjs';
import { rewriteBinShims } from './sea-pipeline.mjs';

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'sota-vendor-target-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function put(root, path, content) {
	const full = join(root, path); mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, content); return full;
}

function native(os, cpu = 'x64') {
	const data = Buffer.alloc(128);
	if (os === 'linux') { data.writeUInt32BE(0x7f454c46); data[4] = 2; data[5] = 1; data.writeUInt16LE(cpu === 'x64' ? 62 : 183, 18); }
	if (os === 'win32') { data.writeUInt16LE(0x5a4d); data.writeUInt32LE(64, 60); data.writeUInt32LE(0x4550, 64); data.writeUInt16LE(cpu === 'x64' ? 0x8664 : 0xaa64, 68); }
	if (os === 'darwin') { data.writeUInt32LE(0xfeedfacf); data.writeUInt32LE(cpu === 'x64' ? 0x01000007 : 0x0100000c, 4); }
	return data;
}

test('cross-build requests glibc and makes native downloads required without host postinstall', () => {
	const args = vendorInstallArgs({ os: 'linux', cpu: 'x64' }, '2.1.138', '0.153.4');
	assert.ok(args.includes('--ignore-scripts')); assert.ok(args.includes('--include=optional'));
	assert.equal(args[args.indexOf('--libc') + 1], 'glibc');
	assert.ok(args.includes('@anthropic-ai/claude-code-linux-x64@2.1.138'));
	assert.ok(args.includes('@openai/codex-linux-x64@npm:@openai/codex@0.153.4-linux-x64'));
});

test('target verification rejects placeholders, wrong operating systems and wrong architecture', t => {
	const root = fixture(t), path = put(root, 'claude.exe', 'Error: native binary not installed');
	assert.throws(() => verifyNativeTarget(path, { os: 'win32', cpu: 'x64' }), /does not match/);
	for (const os of ['linux', 'darwin', 'win32']) {
		writeFileSync(path, native(os)); verifyNativeTarget(path, { os, cpu: 'x64' });
		assert.throws(() => verifyNativeTarget(path, { os, cpu: 'arm64' }), /does not match/);
		assert.throws(() => verifyNativeTarget(path, { os: os === 'linux' ? 'darwin' : 'linux', cpu: 'x64' }), /does not match/);
	}
});

for (const os of ['linux', 'win32']) {
	test(`${os} vendor setup replaces Claude placeholder and keeps Codex launcher distinct on cross-builds`, t => {
		const root = fixture(t), target = { os, cpu: 'x64', exeFormat: os === 'win32' ? 'windows' : 'elf' };
		const extension = os === 'win32' ? '.exe' : '', triple = os === 'win32' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-musl';
		put(root, 'node_modules/@anthropic-ai/claude-code/package.json', JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
		put(root, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe', 'Error: native binary not installed');
		put(root, `node_modules/@anthropic-ai/claude-code-${os}-x64/claude${extension}`, native(os));
		put(root, 'node_modules/@openai/codex/package.json', JSON.stringify({ bin: { codex: 'bin/codex.js' } }));
		put(root, 'node_modules/@openai/codex/bin/codex.js', '#!/usr/bin/env node\nconsole.log("codex");');
		const codex = `node_modules/@openai/codex-${os}-x64/vendor/${triple}`;
		for (const binary of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg']) { put(root, `${codex}/${binary}${extension}`, native(os)); }
		mkdirSync(join(root, 'node_modules/.bin'));
		// Unix npm shims are all a Windows cross-build has before rewriting.
		for (const [name, bin] of [['claude', '../@anthropic-ai/claude-code/bin/claude.exe'], ['codex', '../@openai/codex/bin/codex.js']]) {
			if (process.platform === 'win32') { put(root, `node_modules/.bin/${name}`, 'placeholder shim'); }
			else { symlinkSync(bin, join(root, 'node_modules/.bin', name)); }
		}
		prepareVendorBinaries(root, target); rewriteBinShims(root, target);
		assert.deepEqual(readFileSync(join(root, 'node_modules/@anthropic-ai/claude-code/bin/claude.exe')), native(os));
		const suffix = os === 'win32' ? '.cmd' : '';
		const claude = readFileSync(join(root, `node_modules/.bin/claude${suffix}`), 'utf8');
		const codexShim = readFileSync(join(root, `node_modules/.bin/codex${suffix}`), 'utf8');
		assert.match(claude, /claude-code/); assert.doesNotMatch(claude, /sota-run-node/);
		assert.match(codexShim, /@openai[\\/]codex[\\/]bin[\\/]codex\.js/); assert.match(codexShim, /--sota-run-node/); assert.doesNotMatch(codexShim, /claude/);
		rmSync(join(root, `${codex}/bin/codex${extension}`));
		assert.throws(() => prepareVendorBinaries(root, target), /ENOENT/);
	});
}
