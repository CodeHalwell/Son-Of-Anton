/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:net';

const host = vi.hoisted(() => ({ connection: 'local', socketPath: '', trusted: true, createTerminal: vi.fn(() => ({ show: vi.fn(), dispose: vi.fn() })) }));
vi.mock('vscode', () => ({
	window: { createTerminal: host.createTerminal, showQuickPick: async () => ({ label: 'fixture' }) },
	workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/workspace' } }], getConfiguration: () => ({ get: (key: string) => key === 'connection' ? host.connection : host.socketPath }), get isTrusted() { return host.trusted; } },
	l10n: { t: (value: string, ...args: string[]) => value.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '') },
}));
import { ensureDaemon, getRuntimeEndpoint, openCouncil, openTerminal, runRuntimeCli } from '../src/runtime.js';

describe('private agent engine process boundary', () => {
	let root: string;
	let context: Parameters<typeof runRuntimeCli>[0];
	let server: Server | undefined;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'sota-profile-'));
		host.connection = 'local'; host.socketPath = ''; host.trusted = true;
		vi.stubEnv('SON_OF_ANTON_DATA_DIR', path.join(root, 'anton'));
		vi.stubEnv('SON_OF_ANTON_CONFIG_DIR', path.join(root, 'anton-config'));
		vi.stubEnv('SON_OF_ANTON_SOCKET', path.join(root, 'anton.sock'));
		vi.stubEnv('CODYPENDENT_DATA_DIR', path.join(root, 'cody'));
		vi.stubEnv('CODYPENDENT_CONFIG_DIR', path.join(root, 'cody-config'));
		vi.stubEnv('CODYPENDENT_SOCKET', path.join(root, 'cody.sock'));
		context = { extensionPath: root,
			secrets: { get: async (name: string) => name === 'sota.runtime.provider.anthropic.apiKey' ? 'synthetic-private-fixture-key' : undefined,
				store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
		};
	});

	afterEach(async () => {
		if (server) { await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); server = undefined; }
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	});

	async function installFixture(products = ['codypendent', 'son-of-anton']): Promise<void> {
		const directory = path.join(root, 'runtime/codypendent');
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, runtimeProducts: products }));
		// A real child process exercises env inheritance and argv without loading an agent or provider.
		await writeFile(path.join(directory, 'codypendent'), `#!${process.execPath}\nconst fs = require('node:fs');
if (process.argv[2] === 'fail') { process.stderr.write(process.env.SOTA_RUNTIME_ANTHROPIC_API_KEY); process.exit(1); }
const result = { args: process.argv.slice(2), product: process.env.AGENT_RUNTIME_PRODUCT,
	data: process.env.SON_OF_ANTON_DATA_DIR, config: process.env.SON_OF_ANTON_CONFIG_DIR, socket: process.env.SON_OF_ANTON_SOCKET,
	foreignPaths: ['CODYPENDENT_DATA_DIR','CODYPENDENT_CONFIG_DIR','CODYPENDENT_SOCKET'].filter(name => name in process.env),
	hasCredential: !!process.env.SOTA_RUNTIME_ANTHROPIC_API_KEY };
fs.mkdirSync(result.data, {recursive:true}); fs.writeFileSync(result.data + '/probe.json', JSON.stringify(result));
process.stdout.write(JSON.stringify(process.argv[2] === 'council' ? [{ name: 'fixture' }] : result));\n`, { mode: 0o755 });
	}

	it('executes the bundled engine under private paths and keeps the companion store untouched', async () => {
		await installFixture();
		await mkdir(path.join(root, 'cody'), { recursive: true });
		await writeFile(path.join(root, 'cody/sentinel'), 'companion-state');
		const result = await runRuntimeCli(context, ['models', 'list', '--json']);
		expect(JSON.parse(result.stdout)).toEqual({ args: ['models', 'list', '--json'], product: 'son-of-anton',
			data: path.join(root, 'anton'), config: path.join(root, 'anton-config'), socket: path.join(root, 'anton.sock'), foreignPaths: [], hasCredential: true });
		expect(await readFile(path.join(root, 'cody/sentinel'), 'utf8')).toBe('companion-state');
	});

	it('exposes only runtime paths to extensions inspecting either terminal', async () => {
		await installFixture();
		server = createServer(socket => socket.end());
		await new Promise<void>(resolve => server!.listen(path.join(root, 'anton.sock'), resolve));
		vi.stubEnv('SOTA_TERMINAL_TEST_SECRET', 'synthetic-ambient-secret');
		const extension = { ...context, subscriptions: [] } as unknown as Parameters<typeof openTerminal>[0];
		host.createTerminal.mockClear();
		await openTerminal(extension);
		await openCouncil(extension, true);
		expect(host.createTerminal).toHaveBeenCalledTimes(2);
		for (const call of host.createTerminal.mock.calls) {
			expect(call).toEqual([expect.objectContaining({ env: {
				AGENT_RUNTIME_PRODUCT: 'son-of-anton', SON_OF_ANTON_DATA_DIR: path.join(root, 'anton'),
				SON_OF_ANTON_CONFIG_DIR: path.join(root, 'anton-config'), SON_OF_ANTON_SOCKET: path.join(root, 'anton.sock'),
				CODYPENDENT_DATA_DIR: null, CODYPENDENT_CONFIG_DIR: null, CODYPENDENT_SOCKET: null,
			} })]);
		}
	});

	it('rejects an older bundled binary before it can ignore the product selector', async () => {
		await installFixture(['codypendent']);
		await expect(runRuntimeCli(context, ['models', 'list'])).rejects.toThrow(/needs an update/);
		await expect(readFile(path.join(root, 'anton/probe.json'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('never starts or configures an unavailable external runtime', async () => {
		await installFixture();
		host.connection = 'external';
		await expect(ensureDaemon(context)).rejects.toThrow(/external runtime is unavailable/);
		await expect(runRuntimeCli(context, ['daemon', 'restart'])).rejects.toThrow(/external runtime manages/);
		await expect(readFile(path.join(root, 'anton/probe.json'))).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('allows observation of an explicitly selected already-running external endpoint', async () => {
		host.connection = 'external';
		server = createServer(socket => socket.end());
		await new Promise<void>(resolve => server!.listen(path.join(root, 'cody.sock'), resolve));
		await expect(ensureDaemon(context)).resolves.toBeUndefined();
	});

	it('refuses a captured endpoint after the user changes connections', async () => {
		const endpoint = getRuntimeEndpoint();
		host.connection = 'external';
		await expect(ensureDaemon(context, endpoint)).rejects.toThrow(/runtime changed/);
		await expect(runRuntimeCli(context, ['models', 'list'], endpoint)).rejects.toThrow(/runtime changed/);
	});

	it('does not start or configure a private engine for an untrusted workspace', async () => {
		await installFixture(); host.trusted = false;
		await expect(ensureDaemon(context)).rejects.toThrow(/Trust this workspace/);
		await expect(runRuntimeCli(context, ['models', 'add'])).rejects.toThrow(/Trust this workspace/);
	});

	it('redacts stored credentials from failed child-process diagnostics', async () => {
		await installFixture();
		const error = await runRuntimeCli(context, ['fail']).catch((failure: Error) => failure);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) { throw new Error('Expected the fixture to fail'); }
		expect(error.message).toContain('[redacted]');
		expect(error.message).not.toContain('synthetic-private-fixture-key');
	});
});
