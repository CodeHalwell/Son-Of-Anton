/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { mkdtempSync, mkdirSync, copyFileSync, renameSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';
export async function packageSmoke(source) {
	const directory = mkdtempSync(join(tmpdir(), 'sota-package-smoke-'));
	try {
		const install = join(directory, 'clean install'); mkdirSync(install);
		let binary = join(install, process.platform === 'win32' ? 'sota.exe' : 'sota'); copyFileSync(source, binary);
		const env = { ...process.env, SOTA_CACHE_DIR: join(directory, 'cache') };
		const run = args => {
			const result = spawnSync(binary, args, { cwd: install, env, encoding: 'utf8', timeout: 120_000 });
			assert.equal(result.status, 0, `${args.join(' ')}: ${result.error ?? result.stderr}`); return result.stdout;
		};
		const verifyVendorLaunchers = previousCache => {
			const caches = readdirSync(env.SOTA_CACHE_DIR).filter(entry => !entry.startsWith('.') && entry !== previousCache);
			assert.equal(caches.length, 1, 'Expected a fresh cache for this executable location');
			for (const name of ['claude', 'codex']) {
				const shim = join(env.SOTA_CACHE_DIR, caches[0], 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
				assert.ok(!readFileSync(shim, 'utf8').includes('__SOTA_BIN__'));
				const result = process.platform === 'win32'
					? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`], { cwd: install, env, encoding: 'utf8', timeout: 120_000 })
					: spawnSync(shim, ['--version'], { cwd: install, env, encoding: 'utf8', timeout: 120_000 });
				assert.equal(result.status, 0, `${name}: ${result.error ?? result.stderr}`); assert.match(result.stdout, /\d+\.\d+/);
			}
			return caches[0];
		};
		assert.match(run(['--version']), /\d+\.\d+\.\d+/); assert.match(run(['--help']), /acp-doctor/);
		const originalCache = verifyVendorLaunchers();
		// Both CommonJS and ESM trampolines must preserve arguments after installing in a path with spaces.
		for (const extension of ['cjs', 'mjs']) {
			const script = join(install, `probe.${extension}`); writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)))");
			assert.deepEqual(JSON.parse(run(['--sota-run-node', script, 'space value', 'a&b', '%literal%'])), ['space value', 'a&b', '%literal%']);
		}
		// A session handshake exercises bundled prompt loading and ACP without using credentials or a model.
		await new Promise((resolveProbe, reject) => {
			const child = spawn(binary, ['acp', '--read-only'], { cwd: install, env, stdio: 'pipe' }); let buffer = '', errors = '', completed = false;
			const timer = setTimeout(() => { child.kill(); reject(new Error(`Packaged ACP handshake timed out: ${errors}`)); }, 20_000);
			child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
			child.on('error', error => { clearTimeout(timer); reject(error); });
			child.stdin.on('error', error => { child.kill(); reject(error); });
			child.on('close', code => { clearTimeout(timer); if (code === 0 && completed) { resolveProbe(); } else { reject(new Error(`Packaged ACP exited ${code} before a complete handshake: ${errors}`)); } });
			child.stdout.on('data', chunk => {
				buffer += chunk;
				while (buffer.includes('\n')) {
					const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
					try {
						const response = JSON.parse(line);
						if (response.id === 1) { assert.equal(response.result.protocolVersion, 1); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: install, mcpServers: [] } }) + '\n'); }
						if (response.id === 2) { assert.ok(response.result.sessionId); completed = true; child.stdin.end(); }
					} catch (error) { clearTimeout(timer); child.kill(); reject(error); }
				}
			});
			child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
		});
		const old = binary; binary = join(install, process.platform === 'win32' ? 'relocated.exe' : 'relocated'); renameSync(old, binary); run(['--version']);
		verifyVendorLaunchers(originalCache);
		for (const cache of readdirSync(env.SOTA_CACHE_DIR)) {
			if (cache.startsWith('.')) { continue; }
			const bin = join(env.SOTA_CACHE_DIR, cache, 'node_modules', '.bin');
			for (const entry of readdirSync(bin)) { if (entry === 'claude' || entry === 'claude.cmd' || entry === 'codex' || entry === 'codex.cmd') { assert.ok(!readFileSync(join(bin, entry), 'utf8').includes('__SOTA_BIN__')); } }
		}
		process.stdout.write('Packaged install, help, CJS/ESM trampoline, bundled Claude/Codex launchers, ACP session, and relocation checks passed.\n');
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await packageSmoke(resolve(process.argv[2])); }
