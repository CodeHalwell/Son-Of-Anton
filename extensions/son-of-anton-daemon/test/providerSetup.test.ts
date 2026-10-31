/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it, vi } from 'vitest';
import { configureProvider, credentialEnvironment, providerStatus } from '../src/providerSetup.js';

const localEndpoint = { socketPath: '/fixture/anton.sock', identity: 'fixture-anton', mode: 'local' as const };
const providerCases = [
	{ provider: 'anthropic', runtimeProvider: 'anthropic', model: 'claude-haiku-4-5', envName: 'SOTA_RUNTIME_ANTHROPIC_API_KEY' },
	{ provider: 'openai', runtimeProvider: 'openai', model: 'gpt-4o-mini', envName: 'SOTA_RUNTIME_OPENAI_API_KEY' },
	{ provider: 'google', runtimeProvider: 'gemini', model: 'gemini-2.5-flash', envName: 'SOTA_RUNTIME_GEMINI_API_KEY' },
] as const;

/** Synthetic host storage; no real secrets, provider, child process, or filesystem. */
function hostFixture() {
	const secretValues = new Map<string, string>();
	const metadata = new Map<string, unknown>();
	const store = vi.fn(async (name: string, value: string) => { secretValues.set(name, value); });
	const update = vi.fn(async (name: string, value: unknown) => { metadata.set(name, value); });
	function getMetadata<T>(name: string): T | undefined;
	function getMetadata<T>(name: string, defaultValue: T): T;
	function getMetadata<T>(name: string, defaultValue?: T): T | undefined {
		return metadata.has(name) ? metadata.get(name) as T : defaultValue;
	}
	const context: Parameters<typeof configureProvider>[0] = {
		secrets: {
			get: async (name: string) => secretValues.get(name),
			store,
			delete: async (name: string) => { secretValues.delete(name); },
			onDidChange: () => ({ dispose: () => {} }),
		},
		globalState: {
			get: getMetadata,
			update,
			keys: () => [...metadata.keys()],
			setKeysForSync: () => {},
		},
	};
	const runCli = vi.fn(async (_args: string[]) => ({ stdout: '', stderr: '' }));
	return { context, runCli, store, update, secretValues, metadata };
}

describe('private runtime provider setup', () => {
	it.each(providerCases)('configures $provider through the bundled CLI and keeps the key in host secrets', async ({ provider, runtimeProvider, model, envName }) => {
		const host = hostFixture();
		const key = `synthetic-${provider}-credential`;
		const result = await configureProvider(host.context, { provider, fields: { apiKey: key } }, localEndpoint, host.runCli);
		const status = await providerStatus(host.context);
		const environment = await credentialEnvironment(host.context);

		expect({ ok: result.ok, commands: host.runCli.mock.calls.map(([args]) => args), key: environment[envName], status: status[provider] }).toEqual({
			ok: true,
			commands: [
				['models', 'add', runtimeProvider, model, '--id', `anton/${runtimeProvider}`, '--key-env', envName],
				['daemon', 'restart'],
			],
			key,
			status: { hasApiKey: true, model },
		});
		expect([...host.secretValues.values()]).toEqual([key]);
		expect(JSON.stringify({ result, status, metadata: [...host.metadata], commands: host.runCli.mock.calls })).not.toContain(key);
	});

	it('starts with no configured keys and no invented model selections', async () => {
		const host = hostFixture();
		expect(await providerStatus(host.context)).toEqual({
			anthropic: { hasApiKey: false }, openai: { hasApiKey: false }, google: { hasApiKey: false },
		});
		const environment = await credentialEnvironment(host.context);
		expect(providerCases.map(({ envName }) => environment[envName])).toEqual([undefined, undefined, undefined]);
	});

	it('preserves independently configured providers and honors an explicit model', async () => {
		const host = hostFixture();
		await configureProvider(host.context, { provider: 'anthropic', fields: { apiKey: 'synthetic-anthropic', model: 'claude-sonnet-4-5' } }, localEndpoint, host.runCli);
		await configureProvider(host.context, { provider: 'openai', fields: { apiKey: 'synthetic-openai' } }, localEndpoint, host.runCli);
		const status = await providerStatus(host.context);
		const environment = await credentialEnvironment(host.context);

		expect({ commands: host.runCli.mock.calls.map(([args]) => args), status, keys: [environment.SOTA_RUNTIME_ANTHROPIC_API_KEY, environment.SOTA_RUNTIME_OPENAI_API_KEY] }).toEqual({
			commands: [
				['models', 'add', 'anthropic', 'claude-sonnet-4-5', '--id', 'anton/anthropic', '--key-env', 'SOTA_RUNTIME_ANTHROPIC_API_KEY'],
				['daemon', 'restart'],
				['models', 'add', 'openai', 'gpt-4o-mini', '--id', 'anton/openai', '--key-env', 'SOTA_RUNTIME_OPENAI_API_KEY'],
				['daemon', 'restart'],
			],
			status: {
				anthropic: { hasApiKey: true, model: 'claude-sonnet-4-5' },
				openai: { hasApiKey: true, model: 'gpt-4o-mini' },
				google: { hasApiKey: false },
			},
			keys: ['synthetic-anthropic', 'synthetic-openai'],
		});
	});

	it('preserves the selected model when only its API key is rotated', async () => {
		const host = hostFixture();
		const configured = await configureProvider(host.context, { provider: 'openai', fields: { apiKey: 'synthetic-original-key', model: 'selected-openai-model' } }, localEndpoint, host.runCli);
		host.runCli.mockClear();
		const rotated = await configureProvider(host.context, { provider: 'openai', fields: { apiKey: 'synthetic-rotated-key' } }, localEndpoint, host.runCli);
		expect({
			configured: configured.ok,
			rotated: rotated.ok,
			commands: host.runCli.mock.calls.map(([args]) => args),
			status: (await providerStatus(host.context)).openai,
			key: (await credentialEnvironment(host.context)).SOTA_RUNTIME_OPENAI_API_KEY,
		}).toEqual({
			configured: true,
			rotated: true,
			commands: [
				['models', 'add', 'openai', 'selected-openai-model', '--id', 'anton/openai', '--key-env', 'SOTA_RUNTIME_OPENAI_API_KEY'],
				['daemon', 'restart'],
			],
			status: { hasApiKey: true, model: 'selected-openai-model' },
			key: 'synthetic-rotated-key',
		});
	});

	it('refuses external endpoint configuration before writing any storage or running the CLI', async () => {
		const host = hostFixture();
		const result = await configureProvider(host.context, { provider: 'openai', fields: { apiKey: 'synthetic-external-key' } }, { ...localEndpoint, mode: 'external' }, host.runCli);
		expect({ ok: result.ok, secretWrites: host.store.mock.calls, metadataWrites: host.update.mock.calls, commands: host.runCli.mock.calls }).toEqual({
			ok: false, secretWrites: [], metadataWrites: [], commands: [],
		});
		expect(JSON.stringify(result)).not.toContain('synthetic-external-key');
	});

	it.each(['bedrock', 'foundry', 'unsupported-provider'])('refuses unsupported provider %s without side effects', async provider => {
		const host = hostFixture();
		const result = await configureProvider(host.context, { provider, fields: { apiKey: 'synthetic-unsupported-key' } }, localEndpoint, host.runCli);
		expect({ ok: result.ok, secretWrites: host.store.mock.calls, metadataWrites: host.update.mock.calls, commands: host.runCli.mock.calls }).toEqual({
			ok: false, secretWrites: [], metadataWrites: [], commands: [],
		});
	});

	it.each([
		{ provider: 'openai', fields: {} },
		{ provider: 'openai', fields: { apiKey: '' } },
		{ provider: 'openai', fields: { apiKey: '   ' } },
		{ provider: 'openai', fields: { apiKey: 42 } },
		{ provider: 'openai', fields: null },
		{ provider: 'openai', fields: [] },
		{ provider: 'openai' },
		{ provider: 'openai', fields: { apiKey: 'synthetic-invalid-key', model: '' } },
		{ provider: 'openai', fields: { apiKey: 'synthetic-invalid-key', model: 42 } },
		{ provider: 'openai', fields: { apiKey: 'synthetic-invalid-key', model: 'bad\nmodel' } },
		{ provider: 'openai', fields: { apiKey: 'synthetic-invalid-key', model: '--unsafe-option' } },
		{ provider: 'openai', fields: { apiKey: 'synthetic-invalid-key', baseUrl: 'https://custom.example/v1' } },
	])('rejects malformed input without mutations: %#', async request => {
		const host = hostFixture();
		// Deliberately cross the typed boundary with malformed webview input.
		const result = await configureProvider(host.context, request as never, localEndpoint, host.runCli);
		expect({ ok: result.ok, secretWrites: host.store.mock.calls, metadataWrites: host.update.mock.calls, commands: host.runCli.mock.calls }).toEqual({
			ok: false, secretWrites: [], metadataWrites: [], commands: [],
		});
	});

	it('reports a saved configuration as deferred when an active run prevents restart', async () => {
		const host = hostFixture();
		const key = 'synthetic-deferred-key';
		host.runCli.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockRejectedValueOnce(new Error(`active run diagnostic containing ${key}`));
		const result = await configureProvider(host.context, { provider: 'openai', fields: { apiKey: key } }, localEndpoint, host.runCli);
		expect({ ok: result.ok, deferred: result.deferred, configured: (await providerStatus(host.context)).openai.hasApiKey, key: (await credentialEnvironment(host.context)).SOTA_RUNTIME_OPENAI_API_KEY }).toEqual({
			ok: true, deferred: true, configured: true, key,
		});
		expect(JSON.stringify(result)).not.toContain(key);
		expect(result.message).not.toContain('diagnostic containing');
	});

	it('returns a generic configuration failure without echoing child output or restarting', async () => {
		const host = hostFixture();
		const key = 'synthetic-failed-key';
		host.runCli.mockRejectedValueOnce(Object.assign(new Error(`sensitive child failure ${key}`), { stdout: key, stderr: key }));
		const result = await configureProvider(host.context, { provider: 'openai', fields: { apiKey: key } }, localEndpoint, host.runCli);
		expect({ ok: result.ok, commands: host.runCli.mock.calls.map(([args]) => args) }).toEqual({
			ok: false,
			commands: [['models', 'add', 'openai', 'gpt-4o-mini', '--id', 'anton/openai', '--key-env', 'SOTA_RUNTIME_OPENAI_API_KEY']],
		});
		expect(JSON.stringify(result)).not.toContain(key);
		expect(result.message).not.toContain('sensitive child failure');
	});
});
