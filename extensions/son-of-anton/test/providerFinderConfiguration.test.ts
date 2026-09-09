/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { LlmClient } from 'son-of-anton-core/llm/LlmClient';
import { MODEL_METADATA } from 'son-of-anton-core/llm/modelMetadata';
import { beginAcpModelCatalog, discoveredAcpModelId, discoveredModelId, getDiscoveredModel, registerDiscoveredModels, replaceDiscoveredModels, type DiscoveredModel } from 'son-of-anton-core/llm/DiscoveredModels';
import { liveConfig } from '../src/chat/globalScopedConfig';
import { ProviderFinder } from '../src/providers/ProviderFinder';

suite('Provider Finder configuration boundary', () => {
	const defaults: Record<string, unknown> = { 'acp.agents': [], 'discovery.enabled': false, 'discovery.localServers': true, apiKey: '', foundryDeployments: '{}', bedrockModelMap: '{}', zaiModels: [] };
	let user: Record<string, unknown>, workspace: Record<string, unknown>, secrets: Map<string, string>, broker: Map<string, string>;
	let requests: Array<{ url: string; authorization: string | null; apiKey: string | null }>;
	let changeConfiguration: () => void, failAcpRead: boolean, settingsUpdates: string[], cacheWrites: number;
	let finder: ProviderFinder, llm: LlmClient, directory: string, restore: () => void;

	setup(async () => {
		directory = await mkdtemp(path.join(os.tmpdir(), 'sota-finder-config-'));
		user = {}; workspace = {}; secrets = new Map(); broker = new Map(); requests = []; failAcpRead = false; settingsUpdates = []; cacheWrites = 0;
		const original = { getConfiguration: vscode.workspace.getConfiguration, onDidChangeConfiguration: vscode.workspace.onDidChangeConfiguration, onDidChangeWindowState: vscode.window.onDidChangeWindowState, fetch: globalThis.fetch, homedir: os.homedir, metadata: { ...MODEL_METADATA } };
		const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.endsWith('_API_KEY') || key === 'LM_API_TOKEN'));
		for (const key of Object.keys(environment)) { delete process.env[key]; }
		const configuration = {
			get: <T>(key: string, fallback?: T): T => (workspace[key] ?? user[key] ?? defaults[key] ?? fallback) as T,
			inspect: <T>(key: string) => { if (key === 'acp.agents' && failAcpRead) { throw new Error('private config error'); } return { key: `sota.${key}`, globalValue: user[key] as T | undefined, workspaceValue: workspace[key] as T | undefined, defaultValue: defaults[key] as T | undefined }; },
			has: (key: string) => key in workspace || key in user || key in defaults,
			update: async (key: string) => { settingsUpdates.push(key); },
		};
		Object.assign(vscode.workspace, { getConfiguration: () => configuration, onDidChangeConfiguration: (listener: (event: vscode.ConfigurationChangeEvent) => void) => { changeConfiguration = () => listener({ affectsConfiguration: key => key === 'sota.acp.agents' }); return { dispose() {} }; } });
		Object.assign(vscode.window, { onDidChangeWindowState: () => ({ dispose() {} }) });
		os.homedir = () => directory;
		globalThis.fetch = async (input, init) => {
			const url = String(input), headers = new Headers(init?.headers);
			requests.push({ url, authorization: headers.get('authorization'), apiKey: headers.get('x-api-key') });
			if (url.endsWith('/chat/completions')) { return new Response('data: {"choices":[{"delta":{"content":"fixture response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }); }
			return new Response(JSON.stringify(url.endsWith('/api/tags') ? { models: [{ name: 'fixture-local' }] } : { data: [{ id: 'fixture-chat', type: 'llm' }] }), { headers: { 'content-type': 'application/json' } });
		};
		const secretStore = { get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } };
		const state = new Map<string, unknown>();
		const context = { globalState: { get: <T>(key: string) => state.get(key) as T | undefined, update: async (key: string, value: unknown) => { cacheWrites++; state.set(key, value); } }, secrets: { ...secretStore, onDidChange: () => ({ dispose() {} }) } } as unknown as vscode.ExtensionContext;
		llm = new LlmClient(secretStore, liveConfig('sota'), { getToken: async provider => broker.has(provider) ? { token: broker.get(provider)! } : undefined });
		finder = new ProviderFinder(context, llm);
		restore = () => {
			finder.dispose();
			for (const acpAdapterId of ['finder-removed', 'finder-survivor']) { replaceDiscoveredModels({ provider: 'acp', acpAdapterId }, []); }
			Object.assign(vscode.workspace, { getConfiguration: original.getConfiguration, onDidChangeConfiguration: original.onDidChangeConfiguration });
			Object.assign(vscode.window, { onDidChangeWindowState: original.onDidChangeWindowState });
			globalThis.fetch = original.fetch; os.homedir = original.homedir;
			for (const key of Object.keys(process.env)) { if (key.endsWith('_API_KEY') || key === 'LM_API_TOKEN') { delete process.env[key]; } }
			Object.assign(process.env, environment);
			for (const provider of ['anthropic', 'openai', 'ollama', 'lmstudio', 'foundry', 'bedrock', 'zai'] as const) { replaceDiscoveredModels({ provider }, []); }
			for (const id of Object.keys(MODEL_METADATA)) { delete MODEL_METADATA[id as keyof typeof MODEL_METADATA]; }
			Object.assign(MODEL_METADATA, original.metadata);
		};
	});
	teardown(async () => { restore?.(); await rm(directory, { recursive: true, force: true }); });

	const removed = { id: 'finder-removed', command: 'fixture-removed' };
	const survivor = { id: 'finder-survivor', command: 'fixture-survivor' };
	const acpModel = (agent: typeof removed): DiscoveredModel => ({ id: discoveredAcpModelId(agent.id, 'fixture-model'), provider: 'acp', acpAdapterId: agent.id, model: 'fixture-model', label: agent.id, chat: true, tools: true, images: true, fetchedAt: 1 });
	const settle = () => new Promise<void>(resolve => setImmediate(resolve));
	function advertise(agent: typeof removed): void { beginAcpModelCatalog(agent)([acpModel(agent)], false); }

	test('adapter removal and an authoritative empty list retire picker metadata with automatic discovery disabled', async () => {
		user['acp.agents'] = [removed, survivor]; changeConfiguration();
		advertise(removed); advertise(survivor); await settle();
		const removedId = acpModel(removed).id, survivorId = acpModel(survivor).id;
		user.defaultModel = removedId;
		assert.ok(MODEL_METADATA[removedId] && MODEL_METADATA[survivorId]);
		const late = beginAcpModelCatalog(removed);
		user['acp.agents'] = [survivor]; changeConfiguration();
		assert.deepEqual([MODEL_METADATA[removedId], getDiscoveredModel(removedId), !!MODEL_METADATA[survivorId], user.defaultModel], [undefined, undefined, true, removedId]);
		late([acpModel(removed)], false); await settle();
		user['acp.agents'] = []; changeConfiguration(); await settle();
		const row = finder.snapshot().providers.find(provider => provider.id === 'acp')!;
		assert.deepEqual([row.configurationComplete, row.catalogStatus, row.models, MODEL_METADATA[survivorId], requests, settingsUpdates], [true, 'adapter-required', [], undefined, [], []]);
		assert.ok(cacheWrites > 0 && cacheWrites < 10, 'Retirement must persist without recursive registry captures');
	});

	test('malformed and unreadable adapter edits retain the registry and picker entries', async () => {
		user['acp.agents'] = [removed, survivor]; changeConfiguration(); advertise(removed); advertise(survivor); await settle();
		for (const invalid of [null, {}, [removed, { id: survivor.id }], [removed, removed]]) {
			user['acp.agents'] = invalid; changeConfiguration(); await settle();
			const row = finder.snapshot().providers.find(provider => provider.id === 'acp')!;
			assert.deepEqual([row.catalogStatus, row.configurationComplete, row.models.length, !!MODEL_METADATA[acpModel(removed).id], !!MODEL_METADATA[acpModel(survivor).id]], ['error', false, 2, true, true]);
		}
		failAcpRead = true; changeConfiguration(); await settle();
		assert.ok(!JSON.stringify(finder.snapshot()).includes('private config error'));
		assert.deepEqual([finder.snapshot().providers.find(provider => provider.id === 'acp')!.models.length, requests], [2, []]);
	});

	test('provider picker cannot save an ACP model removed while its selection dialog is open', async () => {
		user['acp.agents'] = [removed]; user['discovery.localServers'] = false; changeConfiguration(); advertise(removed); await settle();
		const original = { quickPick: vscode.window.showQuickPick, warning: vscode.window.showWarningMessage, progress: vscode.window.withProgress };
		let selections = 0; const warnings: string[] = [];
		Object.assign(vscode.window, {
			withProgress: <T>(_options: vscode.ProgressOptions, task: () => Promise<T>) => task(),
			showQuickPick: async (items: Array<{ modelId?: string; id?: string }>) => {
				if (++selections === 1) { return items.find(item => item.modelId === acpModel(removed).id); }
				user['acp.agents'] = []; changeConfiguration();
				return items.find(item => item.id === 'select');
			},
			showWarningMessage: async (message: string) => { warnings.push(message); },
		});
		try { await (finder as unknown as { showPicker(): Promise<void> }).showPicker(); }
		finally { Object.assign(vscode.window, { showQuickPick: original.quickPick, showWarningMessage: original.warning, withProgress: original.progress }); }
		assert.deepEqual([selections, settingsUpdates, MODEL_METADATA[acpModel(removed).id]], [2, [], undefined]);
		assert.match(warnings[0], /no longer available/);
	});

	test('effective local server URLs match live chat and update without recreating the finder', async () => {
		user.ollamaBaseUrl = 'http://localhost:11434'; user.lmstudioBaseUrl = 'http://localhost:1234';
		workspace.ollamaBaseUrl = 'http://localhost:21434'; workspace.lmstudioBaseUrl = 'http://127.0.0.1:2234';
		await finder.refresh({ force: true });
		assert.deepEqual(requests, [{ url: 'http://localhost:21434/api/tags', authorization: null, apiKey: null }, { url: 'http://127.0.0.1:2234/api/v1/models', authorization: null, apiKey: null }]);
		assert.deepEqual([liveConfig('sota').get('ollamaBaseUrl'), liveConfig('sota').get('lmstudioBaseUrl')], [workspace.ollamaBaseUrl, workspace.lmstudioBaseUrl]);
		requests.length = 0; workspace.ollamaBaseUrl = 'http://localhost:31434';
		await finder.refresh({ force: true });
		assert.equal(requests.some(request => request.url === 'http://localhost:31434/api/tags'), true);
	});

	test('legacy workspace Anthropic key is discovered against the user-scoped endpoint', async () => {
		user.apiKey = 'old-global-key'; workspace.apiKey = 'workspace-key';
		user.anthropicBaseUrl = 'https://trusted.example'; workspace.anthropicBaseUrl = 'https://workspace.example';
		const snapshot = await finder.refresh({ force: true, includeLocal: false });
		assert.deepEqual(requests, [{ url: 'https://trusted.example/v1/models?limit=1000', authorization: null, apiKey: 'workspace-key' }]);
		assert.deepEqual([snapshot.providers.find(provider => provider.id === 'anthropic')?.credentialSource, snapshot.providers.find(provider => provider.id === 'anthropic')?.models.length, liveConfig('sota').get('apiKey')], ['setting', 1, 'workspace-key']);
	});

	for (const source of ['secret-storage', 'setting', 'environment'] as const) {
		test(`LM Studio workspace overrides never receive ${source} credentials and retain cached routes`, async () => {
			workspace.lmstudioBaseUrl = 'https://workspace.example/local';
			await finder.refresh({ force: true });
			requests.length = 0;
			if (source === 'secret-storage') { secrets.set('sota.secrets.lmstudioApiKey', 'private-key'); }
			else if (source === 'setting') { user.lmstudioApiKey = 'private-key'; }
			else { process.env.LMSTUDIO_API_KEY = 'private-key'; }
			const snapshot = await finder.refresh({ force: true });
			const provider = snapshot.providers.find(provider => provider.id === 'lmstudio')!;
			assert.deepEqual([provider.catalogStatus, provider.credentialSource, provider.credentialStatus, provider.models.map(model => model.model), requests.some(request => new URL(request.url).origin === 'https://workspace.example')], ['error', source, undefined, ['fixture-chat'], false]);
			assert.match(provider.error ?? '', /endpoint in User settings/);
			assert.equal(JSON.stringify(snapshot).includes('private-key'), false);
			user.lmstudioBaseUrl = 'https://workspace.example:443/local/'; requests.length = 0;
			assert.equal((await finder.refresh({ force: true })).providers.find(provider => provider.id === 'lmstudio')?.catalogStatus, 'ready');
			assert.equal(requests.find(request => new URL(request.url).origin === 'https://workspace.example')?.authorization, 'Bearer private-key');
			delete user.lmstudioBaseUrl; requests.length = 0;
			assert.equal((await finder.refresh({ force: true })).providers.find(provider => provider.id === 'lmstudio')?.catalogStatus, 'error');
			assert.equal(requests.some(request => request.authorization !== null || new URL(request.url).hostname === 'workspace.example'), false);
			workspace.lmstudioBaseUrl = 'http://localhost:1234'; requests.length = 0;
			assert.equal((await finder.refresh({ force: true })).providers.find(provider => provider.id === 'lmstudio')?.catalogStatus, 'ready');
			assert.deepEqual(requests.find(request => request.authorization !== null), { url: 'http://localhost:1234/api/v1/models', authorization: 'Bearer private-key', apiKey: null });
		});
	}

	for (const source of ['secret-storage', 'setting', 'LMSTUDIO_API_KEY', 'LM_API_TOKEN', 'custom-header'] as const) {
		test(`direct and discovered LM Studio inference bind ${source} to the live User endpoint without a catalog scan`, async () => {
			user.lmstudioBaseUrl = 'https://approved.invalid/local'; workspace.lmstudioBaseUrl = 'https://workspace.invalid/local';
			if (source === 'secret-storage') { secrets.set('sota.secrets.lmstudioApiKey', 'private-key'); }
			else if (source === 'setting') { user.lmstudioApiKey = 'private-key'; }
			else if (source === 'custom-header') { user.lmstudioCustomHeaders = '{"Authorization":"Bearer private-key"}'; }
			else { process.env[source] = 'private-key'; }
			const discovered = discoveredModelId('lmstudio', 'fixture-chat');
			registerDiscoveredModels([{ id: discovered, provider: 'lmstudio', model: 'fixture-chat', label: 'Fixture', chat: true, tools: true, images: false, fetchedAt: Date.now() }]);
			for (const model of ['lmstudio-loaded', discovered] as const) {
				const events = [];
				for await (const event of llm.streamRequest({ model, messages: [{ role: 'user', content: 'test' }] })) { events.push(event); }
				assert.deepEqual(requests, [], 'No catalog or inference request may receive the credential');
				assert.match(events.find(event => event.type === 'error')?.error ?? '', /endpoint configured in user settings/i);
				assert.equal(JSON.stringify(events).includes('private-key'), false);
			}
			// The existing LlmClient must use fresh scope inspection after settings change.
			user.lmstudioBaseUrl = 'https://workspace.invalid:443/local/';
			for await (const event of llm.streamRequest({ model: 'lmstudio-loaded', messages: [{ role: 'user', content: 'test' }] })) { assert.notEqual(event.type, 'error'); }
			assert.deepEqual(requests, [{ url: 'https://workspace.invalid/local/v1/chat/completions', authorization: 'Bearer private-key', apiKey: null }]);
			requests.length = 0; workspace.lmstudioBaseUrl = 'https://workspace.invalid/other-path';
			for await (const event of llm.streamRequest({ model: discovered, messages: [{ role: 'user', content: 'test' }] })) { if (event.type === 'error') { assert.match(event.error, /endpoint configured in user settings/i); } }
			assert.deepEqual(requests, [], 'Sharing an origin does not authorize another base path');
		});
	}

	test('anonymous LM Studio inference keeps effective workspace endpoints available', async () => {
		user.lmstudioBaseUrl = 'http://localhost:1234'; workspace.lmstudioBaseUrl = 'http://127.0.0.1:2234/local';
		const events = [];
		for await (const event of llm.streamRequest({ model: 'lmstudio-loaded', messages: [{ role: 'user', content: 'test' }] })) { events.push(event); }
		assert.equal(events.some(event => event.type === 'complete'), true);
		assert.equal(events.some(event => event.type === 'error'), false);
		assert.deepEqual(requests, [{ url: 'http://127.0.0.1:2234/local/v1/chat/completions', authorization: null, apiKey: null }]);
	});

	test('authenticated endpoint comparison includes the full path, not just the origin', async () => {
		user.lmstudioBaseUrl = 'https://trusted.example/approved'; workspace.lmstudioBaseUrl = 'https://trusted.example/unapproved';
		secrets.set('sota.secrets.lmstudioApiKey', 'private-key');
		const provider = (await finder.refresh({ force: true })).providers.find(provider => provider.id === 'lmstudio')!;
		assert.deepEqual([provider.catalogStatus, requests.some(request => new URL(request.url).origin === 'https://trusted.example')], ['error', false]);
	});

	test('an authenticated workspace URL equivalent to the default server remains usable', async () => {
		workspace.lmstudioBaseUrl = 'http://localhost:1234/'; secrets.set('sota.secrets.lmstudioApiKey', 'private-key');
		assert.equal((await finder.refresh({ force: true })).providers.find(provider => provider.id === 'lmstudio')?.catalogStatus, 'ready');
		assert.equal(requests.find(request => new URL(request.url).origin === 'http://localhost:1234')?.authorization, 'Bearer private-key');
	});

	for (const source of ['secret-storage', 'environment', 'broker'] as const) {
		test(`remote workspace endpoints cannot redirect ${source} authentication`, async () => {
			workspace.openaiBaseUrl = 'https://workspace.example/v1';
			if (source === 'secret-storage') { secrets.set('sota.secrets.openaiApiKey', 'private-key'); }
			else if (source === 'environment') { process.env.OPENAI_API_KEY = 'private-key'; }
			else { broker.set('chatgpt-oauth', 'private-key'); }
			const provider = (await finder.refresh({ force: true, includeLocal: false })).providers.find(provider => provider.id === 'openai')!;
			assert.deepEqual([provider.credentialSource, requests], [source, [{ url: 'https://api.openai.com/v1/models', authorization: 'Bearer private-key', apiKey: null }]]);
		});
	}

	test('remote account keys and configured inventories still ignore workspace overrides', async () => {
		user.openaiApiKey = 'global-openai'; workspace.openaiApiKey = 'workspace-openai';
		user.openaiBaseUrl = 'https://trusted.example/v1'; workspace.openaiBaseUrl = 'https://workspace.example/v1';
		user.foundryDeployments = '{"saved":"trusted-deployment"}'; workspace.foundryDeployments = '{}';
		const snapshot = await finder.refresh({ force: true, includeLocal: false });
		assert.deepEqual(requests, [{ url: 'https://trusted.example/v1/models', authorization: 'Bearer global-openai', apiKey: null }]);
		assert.deepEqual(snapshot.providers.find(provider => provider.id === 'foundry')?.models.map(model => model.model), ['trusted-deployment']);
	});
});
