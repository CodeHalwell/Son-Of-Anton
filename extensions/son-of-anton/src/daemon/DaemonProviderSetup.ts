/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import type { ProviderId, ProviderSaveResult } from 'son-of-anton-core/credentials/providerCredentialSaver';
import type { SetupCredentialState } from '../onboarding/SetupWizardPanel';
import { getDaemonEndpoint } from './DaemonChat';

const providerCredentialsChanged = new vscode.EventEmitter<{ restartPending: boolean }>();
export const onDidChangeDaemonProviderCredentials = providerCredentialsChanged.event;

interface ProviderMetadata { hasApiKey: boolean; model?: string }
interface RuntimeProviderStatus {
	mode?: 'local' | 'external';
	anthropic: ProviderMetadata;
	openai: ProviderMetadata;
	google: ProviderMetadata;
}
const messages = (): Record<string, string> => ({
	saved: vscode.l10n.t('Saved for Son of Anton. Inference has not been tested.'),
	'pending-restart': vscode.l10n.t('Saved. Finish current work, then restart the Son of Anton runtime to apply the credential. Inference has not been tested.'),
	external: vscode.l10n.t('Configure models in the application that owns the attached runtime. Son of Anton will not change its configuration.'),
	unsupported: vscode.l10n.t('This provider requires native compatibility or setup in the application that owns an explicitly attached runtime.'),
	invalid: vscode.l10n.t('Enter an API key and a valid provider model ID.'),
	'configure-failed': vscode.l10n.t('The model could not be configured. Existing credentials were preserved.'),
	'secret-failed': vscode.l10n.t('The model entry was saved, but its credential could not be stored securely. Try saving again.'),
});

/** Local setup belongs to Son; an external connection keeps its owner's configuration. */
export async function openDaemonModelSetup(): Promise<void> {
	try {
		const endpoint = await getDaemonEndpoint();
		if (endpoint.mode === 'external') {
			await vscode.window.showInformationMessage(messages().external);
			return;
		}
		await vscode.commands.executeCommand('sota.openSetupWizard');
	} catch {
		await vscode.window.showErrorMessage(vscode.l10n.t('Model setup is unavailable. Reload this window and try again.'));
	}
}

/** Write-only command: the daemon extension owns private runtime configuration and SecretStorage. */
export async function saveDaemonProviderCredentials(provider: ProviderId, fields: Record<string, string>): Promise<ProviderSaveResult> {
	try {
		const result = await vscode.commands.executeCommand<{ ok: boolean; code?: string; deferred?: boolean }>('sota.daemon.configureProvider', { provider, fields });
		if (!result || typeof result.ok !== 'boolean') { throw new Error('missing setup result'); }
		if (result.ok) { providerCredentialsChanged.fire({ restartPending: result.code === 'pending-restart' }); }
		return { ok: result.ok, deferred: result.deferred, message: messages()[result.code ?? ''] ?? vscode.l10n.t('The runtime could not complete provider setup. Retry from the setup wizard.') };
	} catch {
		return { ok: false, message: vscode.l10n.t('The runtime could not complete provider setup. Retry from the setup wizard.') };
	}
}

/** Translate readiness metadata to the existing wizard contract, without inspecting credentials. */
export async function daemonProviderCredentialState(): Promise<SetupCredentialState> {
	const state = await vscode.commands.executeCommand<RuntimeProviderStatus>('sota.daemon.providerStatus');
	const configured = (provider: 'anthropic' | 'openai' | 'google'): boolean => state?.mode !== 'external' && state?.[provider]?.hasApiKey === true && !!state[provider].model;
	const runtimeModels: Partial<Record<ProviderId, string>> = {};
	if (state?.mode !== 'external') {
		for (const provider of ['anthropic', 'openai', 'google'] as const) {
			const model = state?.[provider]?.model;
			if (typeof model === 'string' && model) runtimeModels[provider] = model;
		}
	}
	return {
		runtimeModels,
		anthropic: { hasApiKey: configured('anthropic'), hasOAuth: false }, openai: { hasApiKey: configured('openai'), hasOAuth: false },
		google: { hasApiKey: configured('google') }, foundry: { hasApiKey: false, hasEndpoint: false }, bedrock: { hasAccessKey: false, hasProfile: false },
		openrouter: { hasApiKey: false }, ollama: { hasBaseUrl: false }, lmstudio: { hasBaseUrl: false }, deepseek: { hasApiKey: false },
		mistral: { hasApiKey: false }, groq: { hasApiKey: false }, cerebras: { hasApiKey: false }, together: { hasApiKey: false }, fireworks: { hasApiKey: false }, codex: { hasCli: false },
	};
}

/** Reuse the native panel's forms while keeping provider execution in the private engine. */
export function daemonSetupCallbacks() {
	return { runtime: 'daemon' as const, saveCredentials: saveDaemonProviderCredentials, readCredentialState: daemonProviderCredentialState };
}
