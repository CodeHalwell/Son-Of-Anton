/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { c as createTar } from 'tar';
import { AcpRegistry, ACP_REGISTRY_URL, archivePath, parseRegistry, type RegistryCatalog } from './AcpRegistry';

const catalog: RegistryCatalog = { version: '1', agents: [{ id: 'example', name: 'Example', version: '1.2.3', distribution: { npx: { package: '@example/agent', args: ['--acp'] } } }] };
const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
const digest = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const response = (data: string | Buffer) => new Response(typeof data === 'string' ? data : new Uint8Array(data));

test('registry caching is bounded and package plans pin an exact version without executing it', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-registry-')); t.after(() => rm(root, { recursive: true, force: true })); let calls = 0;
	const registry = new AcpRegistry(root, async () => { calls++; return response(JSON.stringify(catalog)); });
	const plan = await registry.plan('example'); await registry.catalog(); assert.equal(calls, 1); assert.deepEqual(plan.launch?.args, ['--yes', '@example/agent@1.2.3', '--acp']);
	await registry.catalog(true); assert.equal(calls, 2);
	const invalid = structuredClone(catalog); invalid.agents[0].distribution.npx!.package = '@example/agent@latest';
	await writeFile(join(root, 'registry.json'), JSON.stringify(invalid)); await assert.rejects(registry.plan('example'), /exact release/);
});

test('invalid identity, traversal, insecure URLs and oversized registries are rejected', () => {
	assert.throws(() => parseRegistry(JSON.stringify({ ...catalog, agents: [...catalog.agents, ...catalog.agents] })), /duplicate/);
	for (const name of ['../outside', '/absolute', 'C:\\outside', 'safe/../../outside']) { assert.throws(() => archivePath(name), /Unsafe/); }
	assert.doesNotThrow(() => parseRegistry(JSON.stringify({ version: '1', agents: [{ ...catalog.agents[0], distribution: { binary: { 'windows-x86_64': { archive: 'https://example.com/a.zip', cmd: './bin\\adapter.exe' } } } }] })));
	assert.throws(() => parseRegistry(' '.repeat(4 * 1024 * 1024 + 1)), /exceeds/);
	assert.throws(() => parseRegistry(JSON.stringify({ version: '1', agents: [{ ...catalog.agents[0], distribution: { binary: { [platform]: { archive: 'http://example.com/a', cmd: 'adapter' } } } }] })), /HTTPS/);
});

test('binary installation verifies checksum, rejects links, and retains a reusable isolated executable', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-registry-binary-')); t.after(() => rm(root, { recursive: true, force: true })); const source = join(root, 'source'); await mkdir(source); await writeFile(join(source, 'adapter'), 'fixture binary, never executed');
	const archive = join(root, 'agent.tar.gz'); await createTar({ cwd: source, file: archive, gzip: true }, ['adapter']); let data = await readFile(archive); let checksum = digest(data);
	const document = () => JSON.stringify({ version: '1', agents: [{ id: 'binary', name: 'Binary', version: '1.2.3', distribution: { binary: { [platform]: { archive: 'https://example.com/agent.tar.gz', cmd: './adapter', sha256: checksum } } } }] });
	const registry = new AcpRegistry(join(root, 'cache'), async url => response(String(url) === ACP_REGISTRY_URL ? document() : data));
	const launch = await registry.installBinary('binary'); assert.equal(await readFile(launch.command, 'utf8'), 'fixture binary, never executed'); assert.deepEqual(await registry.installBinary('binary'), launch);
	checksum = 'a'.repeat(64); await registry.catalog(true); await assert.rejects(registry.installBinary('binary'), /checksum mismatch/);
	if (process.platform !== 'win32') {
		await symlink('/tmp/outside', join(source, 'link')); await createTar({ cwd: source, file: archive, gzip: true }, ['adapter', 'link']); data = await readFile(archive); checksum = digest(data); await registry.catalog(true); await assert.rejects(registry.installBinary('binary'), /Unsafe archive/);
	}
});

test('missing checksums and downgraded redirects cannot become installable binaries', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-registry-invalid-')); t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new AcpRegistry(root, async () => response(JSON.stringify({ version: '1', agents: [{ id: 'binary', name: 'Binary', version: '1.0.0', distribution: { binary: { [platform]: { archive: 'https://example.com/agent.zip', cmd: 'agent' } } } }] })));
	await assert.rejects(registry.plan('binary'), /no registry checksum/);
	const redirect = new AcpRegistry(join(root, 'redirect'), async () => new Response(null, { status: 302, headers: { location: 'http://example.com/registry' } })); await assert.rejects(redirect.catalog(), /HTTPS/);
});

test('ZIP adapters extract only verified files and reject traversal before writing outside the payload', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-registry-zip-')); t.after(() => rm(root, { recursive: true, force: true }));
	// Fixed single-file ZIP fixtures: an ordinary executable and a ../escape entry.
	const fixtures = ['UEsDBBQAAAAAAAAAIVzA1MwwHgAAAB4AAAALAAAAYmluL2FkYXB0ZXJmaXh0dXJlIGJpbmFyeSwgbmV2ZXIgZXhlY3V0ZWRQSwECFAMUAAAAAAAAACFcwNTMMB4AAAAeAAAACwAAAAAAAAAAAAAA7YEAAAAAYmluL2FkYXB0ZXJQSwUGAAAAAAEAAQA5AAAARwAAAAAA', 'UEsDBBQAAAAAAAAAIVzA1MwwHgAAAB4AAAAJAAAALi4vZXNjYXBlZml4dHVyZSBiaW5hcnksIG5ldmVyIGV4ZWN1dGVkUEsBAhQDFAAAAAAAAAAhXMDUzDAeAAAAHgAAAAkAAAAAAAAAAAAAAO2BAAAAAC4uL2VzY2FwZVBLBQYAAAAAAQABADcAAABFAAAAAAA='];
	let data = Buffer.from(fixtures[0], 'base64');
	const document = () => JSON.stringify({ version: '1', agents: [{ id: 'binary', name: 'Binary', version: '1.0.0', distribution: { binary: { [platform]: { archive: 'https://example.com/agent.zip', cmd: 'bin/adapter', sha256: digest(data) } } } }] });
	const registry = new AcpRegistry(root, async url => response(String(url) === ACP_REGISTRY_URL ? document() : data));
	const launch = await registry.installBinary('binary'); assert.equal(await readFile(launch.command, 'utf8'), 'fixture binary, never executed');
	data = Buffer.from(fixtures[1], 'base64'); await registry.catalog(true);
	await assert.rejects(registry.installBinary('binary'), /invalid relative path|Unsafe archive path/);
	await assert.rejects(readFile(join(root, 'escape')), { code: 'ENOENT' });
});
