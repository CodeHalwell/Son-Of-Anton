/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { parse as parseJson } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import type { ConfigStore, MementoStore, SecretStore } from '../host';
import { MissingCredentialError } from '../auth/types';
import { readBoundedFile } from '../util/readBoundedFile';
import { object } from '../acp/protocol';
import { bedrockFamilyCapabilities, isBedrockSemanticFamily, supportsBedrockClaude } from './BedrockModels';
import { discoveredAcpModels, discoveredModelId, getDiscoveredModel, registerDiscoveredModels, replaceDiscoveredModels, type CatalogProvider, type DiscoveredModel, type CapabilityAvailability } from './DiscoveredModels';

export interface DiscoveredSoftware {
	id: string;
	name: string;
	installed: boolean;
	executable?: string;
	application?: string;
	configFiles: string[];
	/** Presence is not validation; private auth payloads are never loaded or exported. */
	auth: 'file-present' | 'not-detected';
	configuredModels: string[];
}
export interface DiscoveredProvider {
	id: CatalogProvider;
	name: string;
	credentialSource: 'secret-storage' | 'setting' | 'environment' | 'broker' | 'none';
	/** Confirmed absence after every applicable credential source was read successfully; omitted on cached legacy/error rows. */
	credentialStatus?: 'missing';
	catalogStatus: 'not-configured' | 'disabled' | 'ready' | 'error' | 'configuration-only' | 'adapter-required' | 'extension-required' | 'catalog-unavailable';
	/** A successful catalog request does not imply an inference call has been tested. */
	inferenceStatus: 'not-tested' | 'model-tested';
	catalogScope?: string;
	fetchedAt?: number;
	models: DiscoveredModel[];
	error?: string;
	truncated?: boolean;
	/** The entire supported configured model inventory was read successfully; this does not verify management access or inference entitlement. */
	configurationComplete?: boolean;
}
export interface ProviderDiscoverySnapshot {
	version: 1;
	updatedAt: number;
	software: DiscoveredSoftware[];
	providers: DiscoveredProvider[];
}
/** Host policy for binding automatic catalog credentials to a trusted endpoint. */
export type CatalogRequestPolicy = (request: { provider: CatalogProvider; baseUrl: string; authenticated: boolean }) => boolean;
interface DiscoveryRefresh {
	includeLocal: boolean;
	promise: Promise<ProviderDiscoverySnapshot>;
	resolve(value: ProviderDiscoverySnapshot): void;
	reject(error: unknown): void;
}
interface ProviderSpec {
	id: CatalogProvider;
	name: string;
	secret?: string;
	setting?: string;
	env?: string[];
	baseSetting?: string;
	base: string;
	modelsPath: string;
	configuredModelsSetting?: string;
	local?: boolean;
	format?: 'anthropic' | 'google' | 'ollama' | 'lmstudio' | 'fireworks';
}

// Provider-owned list endpoints. See docs/evaluations/provider-discovery-2026-09-08.md for contracts.
const providers: ProviderSpec[] = [
	{ id: 'xai', name: 'xAI / Grok', secret: 'xaiApiKey', setting: 'xaiApiKey', env: ['XAI_API_KEY'], baseSetting: 'xaiBaseUrl', base: 'https://api.x.ai/v1', modelsPath: '/models' },
	{ id: 'moonshot', name: 'Moonshot / Kimi', secret: 'moonshotApiKey', setting: 'moonshotApiKey', env: ['MOONSHOT_API_KEY'], baseSetting: 'moonshotBaseUrl', base: 'https://api.moonshot.ai/v1', modelsPath: '/models' },
	{ id: 'zai', name: 'Z.AI / GLM', secret: 'zaiApiKey', setting: 'zaiApiKey', env: ['ZAI_API_KEY', 'ZHIPUAI_API_KEY'], baseSetting: 'zaiBaseUrl', base: 'https://api.z.ai/api/paas/v4', modelsPath: '', configuredModelsSetting: 'zaiModels' },
	{ id: 'minimax', name: 'MiniMax', secret: 'minimaxApiKey', setting: 'minimaxApiKey', env: ['MINIMAX_API_KEY'], baseSetting: 'minimaxBaseUrl', base: 'https://api.minimax.io/v1', modelsPath: '/models' },
	{ id: 'anthropic', name: 'Anthropic', secret: 'anthropicApiKey', setting: 'apiKey', env: ['ANTHROPIC_API_KEY'], baseSetting: 'anthropicBaseUrl', base: 'https://api.anthropic.com', modelsPath: '/v1/models?limit=1000', format: 'anthropic' },
	{ id: 'openai', name: 'OpenAI', secret: 'openaiApiKey', setting: 'openaiApiKey', env: ['OPENAI_API_KEY'], baseSetting: 'openaiBaseUrl', base: 'https://api.openai.com/v1', modelsPath: '/models' },
	{ id: 'google', name: 'Google Gemini', secret: 'googleApiKey', setting: 'googleApiKey', env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'], base: 'https://generativelanguage.googleapis.com/v1beta', modelsPath: '/models?pageSize=1000', format: 'google' },
	{ id: 'openrouter', name: 'OpenRouter', secret: 'openRouterApiKey', setting: 'openRouterApiKey', env: ['OPENROUTER_API_KEY'], baseSetting: 'openRouterBaseUrl', base: 'https://openrouter.ai/api/v1', modelsPath: '/models' },
	{ id: 'deepseek', name: 'DeepSeek', secret: 'deepSeekApiKey', setting: 'deepSeekApiKey', env: ['DEEPSEEK_API_KEY'], baseSetting: 'deepSeekBaseUrl', base: 'https://api.deepseek.com/v1', modelsPath: '/models' },
	{ id: 'mistral', name: 'Mistral', secret: 'mistralApiKey', setting: 'mistralApiKey', env: ['MISTRAL_API_KEY'], baseSetting: 'mistralBaseUrl', base: 'https://api.mistral.ai/v1', modelsPath: '/models' },
	{ id: 'groq', name: 'Groq', secret: 'groqApiKey', setting: 'groqApiKey', env: ['GROQ_API_KEY'], baseSetting: 'groqBaseUrl', base: 'https://api.groq.com/openai/v1', modelsPath: '/models' },
	{ id: 'cerebras', name: 'Cerebras', secret: 'cerebrasApiKey', setting: 'cerebrasApiKey', env: ['CEREBRAS_API_KEY'], baseSetting: 'cerebrasBaseUrl', base: 'https://api.cerebras.ai/v1', modelsPath: '/models' },
	{ id: 'together', name: 'Together AI', secret: 'togetherApiKey', setting: 'togetherApiKey', env: ['TOGETHER_API_KEY', 'TOGETHERAI_API_KEY'], baseSetting: 'togetherBaseUrl', base: 'https://api.together.ai/v1', modelsPath: '/models' },
	{ id: 'fireworks', name: 'Fireworks', secret: 'fireworksApiKey', setting: 'fireworksApiKey', env: ['FIREWORKS_API_KEY'], baseSetting: 'fireworksManagementBaseUrl', base: 'https://api.fireworks.ai', modelsPath: '/v1/accounts/fireworks/models?pageSize=200', format: 'fireworks' },
	{ id: 'ollama', name: 'Ollama', baseSetting: 'ollamaBaseUrl', base: 'http://localhost:11434', modelsPath: '/api/tags', local: true, format: 'ollama' },
	{ id: 'lmstudio', name: 'LM Studio', secret: 'lmstudioApiKey', setting: 'lmstudioApiKey', env: ['LMSTUDIO_API_KEY', 'LM_API_TOKEN'], baseSetting: 'lmstudioBaseUrl', base: 'http://localhost:1234', modelsPath: '/api/v1/models', local: true, format: 'lmstudio' },
];
const storageKey = 'sota.providerDiscovery.v1';
const ttlMs = 60 * 60 * 1000;
type ConfiguredInventoryProvider = 'foundry' | 'bedrock' | 'zai';
function isConfiguredInventoryProvider(id: CatalogProvider): id is ConfiguredInventoryProvider { return id === 'foundry' || id === 'bedrock' || id === 'zai'; }
function hasConfirmedMissingCredential(provider: DiscoveredProvider): boolean {
	return provider.credentialStatus === 'missing' && provider.credentialSource === 'none' && provider.catalogStatus === 'not-configured'
		&& providers.some(spec => spec.id === provider.id && !spec.local && !spec.configuredModelsSetting);
}

/** Read-only discovery: no CLI execution, tool enabling, model loading, sign-in or inference requests. */
export class ProviderDiscovery {
	private value: ProviderDiscoverySnapshot;
	private pending?: DiscoveryRefresh;
	private queued?: DiscoveryRefresh;
	private cachedIncludeLocal?: boolean;
	private refreshedThisInstance = false;
	private controller = new AbortController();
	private disposed = false;
	constructor(private readonly deps: {
		secrets: SecretStore;
		config: ConfigStore;
		state?: MementoStore;
		credentialResolver?: { getToken(provider: string): Promise<{ token: string } | undefined> };
		home?: string;
		env?: NodeJS.ProcessEnv;
		request?: typeof fetch;
		catalogRequestAllowed?: CatalogRequestPolicy;
	}) {
		const cached = deps.state?.get<ProviderDiscoverySnapshot>(storageKey);
		this.value = validSnapshot(cached) ? cached : { version: 1, updatedAt: 0, software: [], providers: [] };
		const local = this.value.providers.filter(provider => provider.id === 'ollama' || provider.id === 'lmstudio');
		if (local.length) { this.cachedIncludeLocal = local.some(provider => provider.catalogStatus !== 'disabled'); }
		// Local mappings are authoritative now, even if a cached discovery snapshot
		// is still inside its TTL. Never replay removed configured routes on restart.
		const configured = this.configuredProviders().filter(provider => isConfiguredInventoryProvider(provider.id));
		for (const provider of configured) {
			const retainedIds = new Set(provider.models.map(model => model.id));
			registerDiscoveredModels(this.previousConfiguredModels(provider.id as ConfiguredInventoryProvider).filter(model => retainedIds.has(model.id)));
		}
		this.value = { ...this.value, providers: [...this.value.providers.filter(provider => !isConfiguredInventoryProvider(provider.id)), ...configured] };
		for (const provider of this.value.providers) {
			const owned = provider.models.filter(model => model.provider === provider.id);
			if (isConfiguredInventoryProvider(provider.id) && provider.configurationComplete === true) { replaceDiscoveredModels({ provider: provider.id }, owned); }
			else { registerDiscoveredModels(owned); }
		}
	}

	snapshot(): ProviderDiscoverySnapshot {
		const result = structuredClone(this.value);
		for (const provider of result.providers) {
			provider.models = provider.models.map(model => ({ ...(getDiscoveredModel(model.id) ?? model) }));
			provider.inferenceStatus = provider.models.some(model => model.verifiedAt && Date.now() - model.verifiedAt < 24 * 60 * 60 * 1000) ? 'model-tested' : 'not-tested';
		}
		const advertised = discoveredAcpModels();
		const adapter = result.providers.find(provider => provider.id === 'acp');
		if (adapter) { adapter.models = advertised; adapter.catalogStatus = advertised.length ? 'ready' : 'adapter-required'; }
		return result;
	}

	async captureAdvertisedModels(): Promise<void> {
		if (this.disposed) { return; }
		this.value = this.snapshot();
		await this.deps.state?.update(storageKey, this.value);
	}
	dispose(): void {
		this.disposed = true; this.controller.abort();
		const error = new Error('Provider discovery is disposed');
		this.pending?.reject(error); this.queued?.reject(error); this.queued = undefined;
	}

	refresh(options: { force?: boolean; includeLocal?: boolean } = {}): Promise<ProviderDiscoverySnapshot> {
		if (this.disposed) { return Promise.reject(new Error('Provider discovery is disposed')); }
		const includeLocal = options.includeLocal ?? false;
		if (this.pending) {
			const requested = this.queued ?? this.pending;
			if (!options.force && includeLocal === requested.includeLocal) { return requested.promise; }
			// A scan may already have read the old key/endpoint. Coalesce changes into
			// one future scan, whose distinct promise cannot resolve with that old result.
			// Latest options win while queued; another change during that scan can queue one successor.
			this.queued ??= this.createRefresh(includeLocal);
			this.queued.includeLocal = includeLocal;
			return this.queued.promise;
		}
		// A persisted TTL cannot prove credentials still exist after the IDE was closed.
		if (this.refreshedThisInstance && !options.force && includeLocal === this.cachedIncludeLocal && this.value.updatedAt && Date.now() - this.value.updatedAt < ttlMs) { return Promise.resolve(this.snapshot()); }
		const refresh = this.createRefresh(includeLocal); this.startRefresh(refresh); return refresh.promise;
	}

	private createRefresh(includeLocal: boolean): DiscoveryRefresh {
		let resolve!: DiscoveryRefresh['resolve']; let reject!: DiscoveryRefresh['reject'];
		const promise = new Promise<ProviderDiscoverySnapshot>((accept, fail) => { resolve = accept; reject = fail; });
		return { includeLocal, promise, resolve, reject };
	}

	private startRefresh(refresh: DiscoveryRefresh): void {
		this.pending = refresh;
		void this.scan(refresh.includeLocal).then(snapshot => {
			if (this.disposed) { refresh.reject(new Error('Provider discovery is disposed')); }
			else { this.refreshedThisInstance = true; this.cachedIncludeLocal = refresh.includeLocal; refresh.resolve(snapshot); }
		}, error => refresh.reject(error)).then(() => {
			if (this.pending !== refresh) { return; }
			this.pending = undefined;
			const queued = this.queued; this.queued = undefined;
			if (queued && !this.disposed) { this.startRefresh(queued); }
		});
	}

	private async scan(includeLocal: boolean): Promise<ProviderDiscoverySnapshot> {
		const software = await discoverSoftware(this.deps.home ?? homedir(), this.deps.env ?? process.env);
		const discovered: DiscoveredProvider[] = [];
		const work = [...providers];
		await Promise.all(Array.from({ length: 4 }, async () => {
			while (work.length && !this.controller.signal.aborted) {
				const spec = work.shift()!;
				discovered.push(await this.scanProvider(spec, includeLocal));
			}
		}));
		// Z.AI's row is scanned above so its credential source can be reported independently.
		discovered.push(...this.configuredProviders().filter(provider => provider.id !== 'zai'));
		this.controller.signal.throwIfAborted();
		this.value = { version: 1, updatedAt: Date.now(), software, providers: discovered.sort((a, b) => a.name.localeCompare(b.name)) };
		for (const provider of discovered) {
			// ACP catalogs are owned by session negotiation, never replayed from a
			// provider snapshot. Failed or bounded HTTP listings are not authoritative.
			if (provider.id === 'acp' || provider.catalogStatus === 'error') { continue; }
			if (!provider.truncated && (provider.catalogStatus === 'ready' || hasConfirmedMissingCredential(provider) || (isConfiguredInventoryProvider(provider.id) && provider.configurationComplete === true))) { replaceDiscoveredModels({ provider: provider.id }, provider.models); }
			else { registerDiscoveredModels(provider.models); }
		}
		await this.deps.state?.update(storageKey, this.value);
		return this.snapshot();
	}

	private previousConfiguredModels(id: ConfiguredInventoryProvider): DiscoveredModel[] {
		return (this.value.providers.find(provider => provider.id === id)?.models ?? []).filter(model => {
			try { return model.provider === id && model.id === discoveredModelId(id, model.model); }
			catch { return false; }
		});
	}

	private configuredInventory(id: ConfiguredInventoryProvider, name: string, setting: string): DiscoveredProvider {
		let models: DiscoveredModel[] = []; let configurationComplete = false; let configurationError: string | undefined;
		try {
			const raw = this.deps.config.get<unknown>(setting);
			let entries: Array<[string, unknown]>;
			if (id === 'zai') {
				if (raw !== undefined && (!Array.isArray(raw) || raw.length > 1000)) { throw new Error('Invalid configured inventory'); }
				entries = Array.from((raw ?? []) as unknown[], wireId => ['', wireId]);
			} else {
				if (raw !== undefined && (typeof raw !== 'string' || raw.length > 1024 * 1024)) { throw new Error('Invalid configured inventory'); }
				const map: unknown = typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : {};
				if (!object(map) || Object.keys(map).length > 1000) { throw new Error('Invalid configured inventory'); }
				entries = Object.entries(map);
			}
			if (id === 'bedrock') {
				// One invocation route can have several friendly labels, but only one
				// declared semantic family. Resolve aliases identically on restart/refresh.
				const families = new Map<string, string>();
				for (const [family, wireId] of entries) {
					if (typeof wireId !== 'string' || !wireId.trim() || wireId.length > 512 || !family || family.length > 512 || /[\u0000-\u001f\u007f]/.test(family)) { throw new Error('Invalid configured model family'); }
					const previous = families.get(wireId);
					if (previous !== undefined && previous !== family && isBedrockSemanticFamily(previous) && isBedrockSemanticFamily(family)) {
						configurationError = 'Multiple Bedrock model families map to the same invocation ID. Keep one declared model family per invocation ID; previously discovered models are retained.';
						throw new Error(configurationError);
					}
					if (previous === undefined || isBedrockSemanticFamily(family) || !isBedrockSemanticFamily(previous) && family < previous) { families.set(wireId, family); }
				}
				entries = [...families].map(([wireId, family]) => [family, wireId]);
			}
			for (const [label, wireId] of entries) {
				if (typeof wireId !== 'string' || !wireId.trim() || wireId.length > 512) { throw new Error('Invalid configured model ID'); }
				if (id !== 'zai' && (!label || label.length > 512 || /[\u0000-\u001f\u007f]/.test(label))) { throw new Error('Invalid configured model family'); }
				const capabilities = id === 'bedrock' ? bedrockFamilyCapabilities(label) : undefined;
				models.push({ id: discoveredModelId(id, wireId), provider: id, model: wireId, ...(id !== 'zai' ? { modelFamily: label } : {}), label: id === 'zai' ? wireId : `${label} · ${wireId}`, chat: id === 'bedrock' ? supportsBedrockClaude(label, wireId) : 'unknown', tools: capabilities?.tools ?? 'unknown', images: capabilities?.images ?? 'unknown', fetchedAt: Date.now() });
			}
			configurationComplete = true;
		} catch { models = this.previousConfiguredModels(id); }
		return { id, name, credentialSource: 'none', configurationComplete, catalogStatus: configurationComplete ? id === 'zai' ? 'catalog-unavailable' : models.length ? 'configuration-only' : 'not-configured' : 'error', inferenceStatus: 'not-tested', models,
			error: configurationComplete ? undefined : configurationError ?? (id === 'zai' ? 'Could not read the configured model inventory. Use an array of at most 1000 exact model IDs. Previously discovered models are retained.' : 'Could not read the configured model inventory. Use a JSON object mapping names to model IDs, with at most 1000 entries. Previously discovered models are retained.'),
			catalogScope: id === 'foundry' ? 'Configured deployments only. Account-wide deployment discovery requires Azure management access.' : id === 'bedrock' ? 'Configured invocation IDs only. Account-wide model discovery requires AWS management access and an explicitly configured region/profile.' : 'This provider does not document an account model-list endpoint. Add exact model IDs to sota.zaiModels; API and Coding Plan endpoints have separate entitlements.' };
	}

	private configuredProviders(): DiscoveredProvider[] {
		const rows: DiscoveredProvider[] = [];
		for (const [id, name, setting] of [['foundry', 'Microsoft Foundry / Azure OpenAI', 'foundryDeployments'], ['bedrock', 'Amazon Bedrock', 'bedrockModelMap'], ['zai', 'Z.AI / GLM', 'zaiModels']] as const) {
			rows.push(this.configuredInventory(id, name, setting));
		}
		rows.push({ id: 'claude-code', name: 'Claude Code Subscription', credentialSource: 'none', catalogStatus: 'adapter-required', inferenceStatus: 'not-tested', models: [], catalogScope: 'Subscription models are advertised by the configured ACP adapter during a trusted session; Anthropic API access is separate.' });
		rows.push({ id: 'codex', name: 'Codex Subscription', credentialSource: 'none', catalogStatus: 'adapter-required', inferenceStatus: 'not-tested', models: [], catalogScope: 'Subscription models are advertised by a configured ACP adapter. A Codex sign-in is not an OpenAI API key.' });
		rows.push({ id: 'copilot', name: 'GitHub Copilot', credentialSource: 'none', catalogStatus: 'extension-required', inferenceStatus: 'not-tested', models: [], catalogScope: 'Copilot model access belongs to its installed extension and account entitlement; no public API catalog credential is imported.' });
		const advertised = discoveredAcpModels();
		rows.push({ id: 'acp', name: 'ACP Coding Agents', credentialSource: 'none', catalogStatus: advertised.length ? 'ready' : 'adapter-required', inferenceStatus: 'not-tested', models: advertised, catalogScope: 'Only session model IDs actually advertised by configured adapters. Discovery does not launch agents or change permissions.' });
		return rows;
	}

	private async credential(spec: ProviderSpec): Promise<{ value?: string; source: DiscoveredProvider['credentialSource'] }> {
		if (spec.secret) {
			const value = await this.deps.secrets.get(`sota.secrets.${spec.secret}`);
			if (value?.trim()) { return { value: value.trim(), source: 'secret-storage' }; }
		}
		const setting = spec.setting && this.deps.config.get<string>(spec.setting);
		if (typeof setting === 'string' && setting.trim()) { return { value: setting.trim(), source: 'setting' }; }
		for (const key of spec.env ?? []) {
			const value = (this.deps.env ?? process.env)[key];
			if (value?.trim()) { return { value: value.trim(), source: 'environment' }; }
		}
		if (spec.id === 'anthropic' || spec.id === 'openai') {
			// A failed broker lookup is not evidence that its credential was removed.
			const providerId = spec.id === 'anthropic' ? 'anthropic-oauth' : 'chatgpt-oauth';
			try {
				const record = await this.deps.credentialResolver?.getToken(providerId);
				if (record !== undefined) {
					if (!record || typeof record.token !== 'string' || !record.token.trim()) { throw new Error('Invalid broker credential'); }
					return { value: record.token.trim(), source: 'broker' };
				}
			} catch (error) { if (!(error instanceof MissingCredentialError) || error.providerId !== providerId) { throw error; } }
		}
		return { source: 'none' };
	}

	private async scanProvider(spec: ProviderSpec, includeLocal: boolean): Promise<DiscoveredProvider> {
		const result: DiscoveredProvider = { id: spec.id, name: spec.name, credentialSource: 'none', catalogStatus: 'not-configured', inferenceStatus: 'not-tested', models: [] };
		if (spec.local && !includeLocal) { result.catalogStatus = 'disabled'; return result; }
		if (spec.configuredModelsSetting && isConfiguredInventoryProvider(spec.id)) {
			// Local inventory authority does not depend on API credentials or network access.
			const configured = this.configuredInventory(spec.id, spec.name, spec.configuredModelsSetting);
			try { configured.credentialSource = (await this.credential(spec)).source; }
			catch { configured.error ??= 'Could not read this provider’s credential. Check sign-in before running a request.'; }
			return configured;
		}
		try {
			const credential = await this.credential(spec);
			result.credentialSource = credential.source;
			if (!credential.value && !spec.local) { result.credentialStatus = 'missing'; return result; }
			const configured = spec.baseSetting && this.deps.config.get<string>(spec.baseSetting);
			const base = (typeof configured === 'string' && configured.trim() ? configured.trim() : spec.base).replace(/\/+$/, '');
			const url = new URL(`${base}${spec.modelsPath}`);
			if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) { throw new Error('invalid-endpoint'); }
			if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) { throw new Error('insecure-endpoint'); }
			if (this.deps.catalogRequestAllowed?.({ provider: spec.id, baseUrl: base, authenticated: !!credential.value }) === false) { throw new Error('untrusted-catalog-endpoint'); }
			const headers: Record<string, string> = { accept: 'application/json' };
			if (credential.value) {
				if (spec.id === 'google') { headers['x-goog-api-key'] = credential.value; }
				else if (spec.id === 'anthropic' && credential.source !== 'broker') { headers['x-api-key'] = credential.value; }
				else { headers.Authorization = `Bearer ${credential.value}`; }
			}
			if (spec.id === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; }
			const seenPages = new Set<string>();
			const models = new Map<string, DiscoveredModel>();
			let next: URL | undefined = url;
			for (let page = 0; next && page < 10; page++) {
				if (seenPages.has(next.href)) { throw new Error('repeated-page'); }
				seenPages.add(next.href);
				let body: unknown;
				try { body = await this.readJson(next, headers); } catch (error) {
					if (spec.id !== 'lmstudio' || page !== 0 || !(error instanceof Error) || error.message !== 'HTTP 404') { throw error; }
					// Older LM Studio releases expose only the OpenAI-compatible list; missing metadata stays unknown.
					body = await this.readJson(new URL(`${base.replace(/\/v1$/, '')}/v1/models`), headers);
				}
				const rows = Array.isArray(body) ? body : object(body) ? (Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : undefined) : undefined;
				if (!rows) { throw new Error('invalid-catalog'); }
				for (const row of rows) {
					const model = parseModel(spec, row);
					if (model) { models.set(model.id, model); }
					if (models.size >= 10000) { result.truncated = true; break; }
				}
				next = undefined;
				if (object(body) && spec.format === 'anthropic' && body.has_more === true && typeof body.last_id === 'string') { next = new URL(url); next.searchParams.set('after_id', body.last_id); }
				if (object(body) && (spec.format === 'google' || spec.format === 'fireworks') && typeof body.nextPageToken === 'string' && body.nextPageToken) { next = new URL(url); next.searchParams.set('pageToken', body.nextPageToken); }
				if (models.size >= 10000) { break; }
			}
			if (next) { result.truncated = true; }
			result.models = [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
			result.catalogScope = spec.id === 'fireworks' ? 'Fireworks public-account catalog. Private models and dedicated deployments require account-specific management access.' : spec.local ? 'Models available on the configured local server.' : 'Models listed for the configured provider credential; inference availability is not yet tested.';
			result.catalogStatus = 'ready'; result.fetchedAt = Date.now();
		} catch (error) {
			result.catalogStatus = 'error';
			// Never expose provider bodies, endpoint query parameters, credentials, or raw filesystem errors.
			const message = error instanceof Error ? error.message : '';
			result.error = /^HTTP (401|403)$/.test(message) ? 'Catalog authentication was rejected. Check this provider’s sign-in or API key.'
				: message === 'HTTP 429' ? 'Catalog rate limit reached. Cached models are retained; refresh later.'
					: message === 'insecure-endpoint' ? 'Catalog endpoints require HTTPS except for localhost.'
						: message === 'untrusted-catalog-endpoint' ? 'Authenticated catalog discovery requires this endpoint in User settings. Configure the provider URL there, then refresh. Cached models are retained.'
							: 'Could not read the provider catalog. Check the endpoint, credentials, and server availability.';
			result.models = this.value.providers.find(provider => provider.id === spec.id)?.models ?? [];
		}
		return result;
	}

	private async readJson(url: URL, headers: Record<string, string>): Promise<unknown> {
		const response = await (this.deps.request ?? fetch)(url, { headers, redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(6000)]) });
		if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
		if (!response.body) { throw new Error('empty-catalog'); }
		const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
		try {
			while (true) {
				const chunk = await reader.read(); if (chunk.done) { break; }
				bytes += chunk.value.byteLength;
				if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('catalog-too-large'); }
				chunks.push(chunk.value);
			}
		} finally { reader.releaseLock(); }
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	}
}

function parseModel(spec: ProviderSpec, value: unknown): DiscoveredModel | undefined {
	if (!object(value)) { return undefined; }
	let name = text(value.id) ?? text(value.key) ?? text(value.name);
	if (!name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) { return undefined; }
	if (spec.id === 'google') { name = name.replace(/^models\//, ''); }
	const caps = object(value.capabilities) ? value.capabilities : {};
	const architecture = object(value.architecture) ? value.architecture : {};
	const modalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
	const outputs = Array.isArray(architecture.output_modalities) ? architecture.output_modalities : [];
	const parameters = Array.isArray(value.supported_parameters) ? value.supported_parameters : [];
	const methods = Array.isArray(value.supportedGenerationMethods) ? value.supportedGenerationMethods : [];
	const model: DiscoveredModel = {
		id: discoveredModelId(spec.id, name), provider: spec.id, model: name,
		label: (text(value.display_name) ?? text(value.displayName) ?? text(value.name) ?? name).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200),
		capabilitySource: 'catalog-reported', chat: flag(caps.completion_chat), images: flag(caps.vision), tools: flag(caps.function_calling), fetchedAt: Date.now(),
	};
	if (spec.id === 'anthropic') { model.chat = true; model.images = object(caps.image_input) ? flag(caps.image_input.supported) : 'unknown'; }
	if (spec.id === 'moonshot') { model.images = flag(value.supports_image_in); }
	if (spec.id === 'google') { model.chat = methods.includes('generateContent'); }
	if (spec.id === 'openrouter') { model.chat = outputs.length ? outputs.includes('text') : 'unknown'; model.images = modalities.length ? modalities.includes('image') : 'unknown'; model.tools = parameters.length ? parameters.includes('tools') : 'unknown'; }
	if (spec.id === 'lmstudio') { model.chat = value.type === 'llm' ? true : value.type === 'embedding' ? false : 'unknown'; model.tools = flag(caps.trained_for_tool_use); }
	if (spec.id === 'fireworks') { model.images = flag(value.supportsImageInput); model.tools = flag(value.supportsTools); model.chat = value.supportsServerless === true ? true : 'unknown'; }
	if (spec.id === 'together' && typeof value.type === 'string') { model.chat = value.type === 'chat'; }
	if (typeof caps.tools === 'boolean') { model.tools = caps.tools; }
	if (/embedding|whisper|tts|moderation|dall-e|image-generation|realtime|transcri(?:be|ption)/i.test(name)) { model.chat = false; }
	model.contextWindow = positive(value.max_input_tokens ?? value.context_length ?? value.contextLength ?? value.max_context_length ?? value.inputTokenLimit);
	model.maxOutputTokens = positive(value.max_tokens ?? value.max_output_tokens ?? value.outputTokenLimit);
	const pricing = object(value.pricing) ? value.pricing : {};
	if (spec.id === 'openrouter') {
		const input = numeric(pricing.prompt), output = numeric(pricing.completion);
		if (input !== undefined && output !== undefined) { model.pricing = { inputPerMillion: input * 1_000_000, outputPerMillion: output * 1_000_000 }; }
	}
	if (spec.id === 'together') {
		const input = numeric(pricing.input), output = numeric(pricing.output);
		if (input !== undefined && output !== undefined) { model.pricing = { inputPerMillion: input, outputPerMillion: output }; }
	}
	return model;
}

async function discoverSoftware(home: string, env: NodeJS.ProcessEnv): Promise<DiscoveredSoftware[]> {
	const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
	const codex = env.CODEX_HOME || path.join(home, '.codex');
	const specs = [
		{ id: 'claude', name: 'Claude Code', commands: ['claude'], apps: [], files: [path.join(home, '.claude/settings.json'), path.join(home, '.claude.json')], auth: [path.join(home, '.claude/.credentials.json')] },
		{ id: 'codex', name: 'Codex', commands: ['codex'], apps: ['Codex.app'], files: [path.join(codex, 'config.toml')], auth: [path.join(codex, 'auth.json')] },
		{ id: 'kimi', name: 'Kimi Code', commands: ['kimi'], files: [path.join(home, '.kimi/config.toml')] },
		{ id: 'gemini', name: 'Gemini CLI', commands: ['gemini'], files: [path.join(home, '.gemini/settings.json')], auth: [path.join(home, '.gemini/oauth_creds.json')] },
		{ id: 'cursor', name: 'Cursor', commands: ['cursor', 'cursor-agent'], apps: ['Cursor.app'], files: [path.join(home, '.cursor/cli-config.json')] },
		{ id: 'vscode', name: 'Visual Studio Code', commands: ['code', 'code-insiders'], apps: ['Visual Studio Code.app', 'Visual Studio Code - Insiders.app'], files: [] },
		{ id: 'opencode', name: 'OpenCode', commands: ['opencode'], files: [path.join(config, 'opencode/opencode.json'), path.join(config, 'opencode/opencode.jsonc')], auth: [path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode/auth.json')] },
		{ id: 'aider', name: 'Aider', commands: ['aider'], files: [path.join(home, '.aider.conf.yml')] },
		{ id: 'goose', name: 'Goose', commands: ['goose'], apps: ['Goose.app'], files: [path.join(config, 'goose/config.yaml')] },
		{ id: 'continue', name: 'Continue', commands: ['cn'], files: [path.join(home, '.continue/config.yaml'), path.join(home, '.continue/config.json')], extension: 'continue.continue-' },
		{ id: 'cline', name: 'Cline', commands: ['cline'], files: [], extension: 'saoudrizwan.claude-dev-' },
		{ id: 'roo', name: 'Roo Code', commands: [], files: [], extension: 'rooveterinaryinc.roo-cline-' },
		{ id: 'copilot', name: 'GitHub Copilot', commands: ['copilot'], files: [], extension: 'github.copilot-' },
		{ id: 'windsurf', name: 'Windsurf', commands: ['windsurf'], apps: ['Windsurf.app'], files: [path.join(home, '.codeium/windsurf/mcp_config.json')] },
		{ id: 'antigravity', name: 'Antigravity', commands: ['antigravity'], apps: ['Antigravity.app'], files: [path.join(home, '.gemini/antigravity/mcp_config.json')] },
		{ id: 'zed', name: 'Zed', commands: ['zed'], apps: ['Zed.app'], files: [path.join(config, 'zed/settings.json')] },
		{ id: 'ollama', name: 'Ollama', commands: ['ollama'], apps: ['Ollama.app'], files: [] },
		{ id: 'lmstudio', name: 'LM Studio', commands: ['lms'], apps: ['LM Studio.app'], files: [] },
	];
	const extensionDirs = [path.join(home, '.vscode/extensions'), path.join(home, '.vscode-insiders/extensions'), path.join(home, '.cursor/extensions'), path.join(home, '.windsurf/extensions')];
	const extensions = (await Promise.all(extensionDirs.map(async directory => { try { return (await readdir(directory)).slice(0, 5000); } catch { return []; } }))).flat();
	return Promise.all(specs.map(async spec => {
		const executable = await findExecutable(spec.commands, env);
		let application: string | undefined;
		for (const app of spec.apps ?? []) { for (const base of ['/Applications', path.join(home, 'Applications')]) { const filename = path.join(base, app); if (await exists(filename)) { application = filename; break; } } }
		const configFiles: string[] = [], models = new Set<string>();
		for (const filename of spec.files) {
			if (!await exists(filename)) { continue; }
			configFiles.push(filename);
			try {
				const raw = (await readBoundedFile(filename, 256 * 1024)).content;
				const parsed: unknown = filename.endsWith('.toml') ? (await import('smol-toml')).parse(raw) : /\.ya?ml$/.test(filename) ? parseYaml(raw, { maxAliasCount: 20 }) : parseJson(raw);
				if (!object(parsed)) { continue; }
				// Read only documented model fields, never recursively enumerate potentially secret values.
				for (const value of [parsed.model, parsed['weak-model'], parsed['editor-model'], parsed.GOOSE_MODEL]) { if (typeof value === 'string' && safeModelReference(value)) { models.add(value); } }
				if (object(parsed.model) && typeof parsed.model.name === 'string' && safeModelReference(parsed.model.name)) { models.add(parsed.model.name); }
				if (Array.isArray(parsed.models)) { for (const model of parsed.models.slice(0, 100)) { if (object(model) && typeof model.model === 'string' && safeModelReference(model.model)) { models.add(model.model); } } }
			} catch { /* Config presence remains visible even when its format/version cannot be parsed. */ }
		}
		let auth: DiscoveredSoftware['auth'] = 'not-detected';
		for (const filename of spec.auth ?? []) { if (await exists(filename)) { auth = 'file-present'; break; } }
		return { id: spec.id, name: spec.name, installed: !!executable || !!application || !!spec.extension && extensions.some(name => name.toLowerCase().startsWith(spec.extension!)), executable, application, configFiles, auth, configuredModels: [...models] };
	}));
}

async function findExecutable(commands: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const directories = (env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory)).slice(0, 100);
	const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
	for (const command of commands) { for (const directory of directories) { for (const suffix of suffixes) {
		const filename = path.join(directory, command + suffix);
		try { if ((await stat(filename)).isFile()) { await access(filename, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return filename; } } catch { /* Not installed here. */ }
	} } }
	return undefined;
}
async function exists(filename: string): Promise<boolean> { try { await access(filename); return true; } catch { return false; } }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function flag(value: unknown): CapabilityAvailability { return typeof value === 'boolean' ? value : 'unknown'; }
function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined; }
function numeric(value: unknown): number | undefined { const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN; return Number.isFinite(result) && result >= 0 ? result : undefined; }
function safeModelReference(value: string): boolean { return value.length < 200 && /^[\w][\w./:@-]*$/.test(value) && !/^(?:sk-|Bearer|eyJ)/.test(value); }
function validSnapshot(value: unknown): value is ProviderDiscoverySnapshot {
	return object(value) && value.version === 1 && typeof value.updatedAt === 'number' && Array.isArray(value.software) && Array.isArray(value.providers)
		&& value.providers.every(provider => object(provider) && typeof provider.id === 'string' && Array.isArray(provider.models) && provider.models.every(model => object(model) && typeof model.id === 'string' && typeof model.provider === 'string' && typeof model.model === 'string'));
}
