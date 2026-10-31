/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type * as vscode from 'vscode';

interface RuntimeEndpoint { socketPath: string; identity: string; mode: 'local' | 'external' }
interface ProviderRequest { provider: string; fields: Record<string, string> }
interface CliResult { stdout: string; stderr: string }
type SetupContext = Pick<vscode.ExtensionContext, 'secrets' | 'globalState'>;
type Provider = 'anthropic' | 'openai' | 'google';
export interface ProviderSetupResult {
	ok: boolean;
	message: string;
	deferred?: boolean;
	code: 'saved' | 'pending-restart' | 'external' | 'unsupported' | 'invalid' | 'configure-failed' | 'secret-failed';
}
const profiles = {
	anthropic: { catalog: 'anthropic', model: 'claude-haiku-4-5', environment: 'SOTA_RUNTIME_ANTHROPIC_API_KEY' },
	openai: { catalog: 'openai', model: 'gpt-4o-mini', environment: 'SOTA_RUNTIME_OPENAI_API_KEY' },
	google: { catalog: 'gemini', model: 'gemini-2.5-flash', environment: 'SOTA_RUNTIME_GEMINI_API_KEY' },
} as const;
const secretKey = (provider: Provider): string => `sota.runtime.provider.${provider}.apiKey`;
const modelKey = (provider: Provider): string => `sota.runtime.provider.${provider}.model`;
const operations = new WeakMap<SetupContext, Promise<void>>();
const isProvider = (value: string): value is Provider => Object.hasOwn(profiles, value);
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/;

/** Boolean metadata only. Secret values are never returned to a webview or command caller. */
export async function providerStatus(context: SetupContext): Promise<Record<Provider, { hasApiKey: boolean; model?: string }>> {
	const entries = await Promise.all((Object.keys(profiles) as Provider[]).map(async provider => [provider, {
		hasApiKey: !!(await context.secrets.get(secretKey(provider)))?.trim(),
		model: context.globalState.get<string>(modelKey(provider)),
	}] as const));
	return Object.fromEntries(entries) as Record<Provider, { hasApiKey: boolean; model?: string }>;
}

/** Private launcher capability. This function must never be registered as a command. */
export async function credentialEnvironment(context: Pick<SetupContext, 'secrets'>): Promise<NodeJS.ProcessEnv> {
	const environment: NodeJS.ProcessEnv = {};
	for (const provider of Object.keys(profiles) as Provider[]) {
		const key = await context.secrets.get(secretKey(provider));
		if (key) { environment[profiles[provider].environment] = key; }
	}
	return environment;
}

/** Configure only the product-owned runtime. The injected CLI runner pins the expected endpoint. */
export async function configureProvider(context: SetupContext, request: ProviderRequest, endpoint: RuntimeEndpoint,
	runCli: (args: string[]) => Promise<CliResult>): Promise<ProviderSetupResult> {
	if (endpoint.mode !== 'local') {
		return { ok: false, code: 'external', message: 'Configure models in the application that owns the attached runtime.' };
	}
	if (!request || typeof request.provider !== 'string' || !isProvider(request.provider)) {
		return { ok: false, code: 'unsupported', message: 'This provider is available through native compatibility or an explicitly attached runtime.' };
	}
	const provider = request.provider;
	const fields = request.fields;
	if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
		return { ok: false, code: 'invalid', message: 'Enter an API key and a valid provider model ID.' };
	}
	if (Object.entries(fields).some(([name, value]) => !['apiKey', 'model'].includes(name) && typeof value === 'string' && value.trim())) {
		return { ok: false, code: 'unsupported', message: 'Custom provider endpoints and options require native compatibility or setup in the application that owns an explicitly attached runtime.' };
	}
	const key = typeof fields.apiKey === 'string' ? fields.apiKey.trim() : '';
	const requestedModel = fields.model === undefined ? undefined : typeof fields.model === 'string' ? fields.model.trim() : '';
	if (!key || key.length > 16_384 || /[\x00-\x20\x7f]/.test(key) || requestedModel !== undefined && !modelPattern.test(requestedModel)) {
		return { ok: false, code: 'invalid', message: 'Enter an API key and a valid provider model ID.' };
	}
	const previous = operations.get(context) ?? Promise.resolve();
	let result!: ProviderSetupResult;
	const operation = previous.catch(() => {}).then(async () => {
		const profile = profiles[provider];
		// Read after earlier setup operations commit, so key rotation cannot reset their selection.
		const savedModel = context.globalState.get<string>(modelKey(provider));
		const model = requestedModel ?? (typeof savedModel === 'string' && savedModel.trim() ? savedModel.trim() : profile.model);
		if (!modelPattern.test(model)) {
			result = { ok: false, code: 'invalid', message: 'Enter an API key and a valid provider model ID.' };
			return;
		}
		try {
			// Only the environment variable NAME reaches argv or models.toml.
			await runCli(['models', 'add', profile.catalog, model, '--id', `anton/${profile.catalog}`, '--key-env', profile.environment]);
		} catch {
			result = { ok: false, code: 'configure-failed', message: 'The model could not be configured. Existing credentials were preserved.' };
			return;
		}
		try {
			await context.secrets.store(secretKey(provider), key);
			await context.globalState.update(modelKey(provider), model);
		} catch {
			result = { ok: false, code: 'secret-failed', message: 'The model entry was saved, but its credential could not be stored securely. Try saving again.' };
			return;
		}
		try {
			// The existing CLI restart is idle-guarded; active work is never cancelled.
			await runCli(['daemon', 'restart']);
			result = { ok: true, code: 'saved', deferred: true, message: 'Saved for Son of Anton. Inference has not been tested.' };
		} catch {
			// Never forward raw subprocess errors: they can include an inherited environment.
			result = { ok: true, code: 'pending-restart', deferred: true, message: 'Saved. Finish current work, then restart the Son of Anton runtime to apply the credential. Inference has not been tested.' };
		}
	});
	operations.set(context, operation);
	await operation;
	return result;
}
