/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { onDiscoveredModelsChanged } from 'son-of-anton-core/llm/DiscoveredModels';
import type { LlmClient, ModelId } from 'son-of-anton-core/llm/LlmClient';
import { MODEL_METADATA, type ModelCapability } from 'son-of-anton-core/llm/modelMetadata';
import type { ProviderDiscovery, ProviderDiscoverySnapshot } from 'son-of-anton-core/llm/ProviderDiscovery';

/** Cached provider inventory with automatic bounded refresh and a searchable command-palette fallback. */
export class ProviderFinder implements vscode.Disposable {
	private readonly change = new vscode.EventEmitter<ProviderDiscoverySnapshot>();
	readonly onDidChange = this.change.event;
	private readonly service: ProviderDiscovery;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly timer: ReturnType<typeof setInterval>;
	private disposed = false;
	constructor(private readonly context: vscode.ExtensionContext, private readonly llmClient: LlmClient) {
		this.service = llmClient.createProviderDiscovery(context.globalState, {
			get: <T>(key: string, fallback?: T): T => {
				const setting = vscode.workspace.getConfiguration('sota').inspect<T>(key);
				return (setting?.globalValue ?? setting?.defaultValue ?? fallback) as T;
			},
		});
		this.registerMetadata(this.service.snapshot());
		this.disposables.push(onDiscoveredModelsChanged(() => {
			if (this.disposed) { return; }
			void this.service.captureAdvertisedModels().then(() => { if (!this.disposed) { const snapshot = this.snapshot(); this.registerMetadata(snapshot); this.change.fire(snapshot); } }, () => {});
		}));
		this.disposables.push(vscode.commands.registerCommand('sota.refreshProviders', async () => this.refresh({ force: true })));
		this.disposables.push(vscode.commands.registerCommand('sota.verifyProviderModel', async () => this.verifyModel()));
		this.disposables.push(vscode.commands.registerCommand('sota.findProviders', async () => this.showPicker()));
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (['discovery', 'xaiApiKey', 'xaiBaseUrl', 'moonshotApiKey', 'moonshotBaseUrl', 'zaiApiKey', 'zaiBaseUrl', 'zaiModels', 'minimaxApiKey', 'minimaxBaseUrl', 'apiKey', 'openaiApiKey', 'googleApiKey', 'openRouterApiKey', 'deepSeekApiKey', 'mistralApiKey', 'groqApiKey', 'cerebrasApiKey', 'togetherApiKey', 'fireworksApiKey', 'anthropicBaseUrl', 'openaiBaseUrl', 'googleBaseUrl', 'openRouterBaseUrl', 'deepSeekBaseUrl', 'mistralBaseUrl', 'groqBaseUrl', 'cerebrasBaseUrl', 'togetherBaseUrl', 'fireworksManagementBaseUrl', 'ollamaBaseUrl', 'lmstudioBaseUrl', 'foundryDeployments', 'foundryEndpoint', 'bedrockModelMap'].some(key => event.affectsConfiguration(`sota.${key}`))) { void this.automaticRefresh(true); }
		}));
		this.disposables.push(context.secrets.onDidChange(() => { void this.automaticRefresh(true); }));
		this.disposables.push(vscode.window.onDidChangeWindowState(state => { if (state.focused) { void this.automaticRefresh(); } }));
		this.timer = setInterval(() => { void this.automaticRefresh(); }, 60 * 60 * 1000);
		this.timer.unref();
		void this.automaticRefresh();
	}

	snapshot(): ProviderDiscoverySnapshot { return this.service.snapshot(); }

	async refresh(options: { force?: boolean; includeLocal?: boolean } = {}): Promise<ProviderDiscoverySnapshot> {
		const value = await this.service.refresh({ ...options, includeLocal: options.includeLocal ?? vscode.workspace.getConfiguration('sota').get<boolean>('discovery.localServers', true) });
		if (!this.disposed) { this.registerMetadata(value); this.change.fire(value); }
		return value;
	}

	dispose(): void {
		this.disposed = true; clearInterval(this.timer); this.service.dispose();
		for (const disposable of this.disposables) { disposable.dispose(); }
		this.change.dispose();
	}

	private async automaticRefresh(force = false): Promise<void> {
		if (this.disposed || !vscode.workspace.getConfiguration('sota').get<boolean>('discovery.enabled', true)) { return; }
		try { await this.refresh({ force }); } catch { /* Explicit refresh surfaces status; background scans remain unobtrusive. */ }
	}

	private registerMetadata(snapshot: ProviderDiscoverySnapshot): void {
		for (const provider of snapshot.providers) {
			for (const model of provider.models) {
				if (model.chat === false) { continue; }
				const capabilities: ModelCapability[] = ['text'];
				if (model.images === true) { capabilities.push('vision'); }
				if (model.tools === true) { capabilities.push('tools'); }
				MODEL_METADATA[model.id] = {
					discovered: true, pricingStatus: model.pricing ? 'reported' : 'unknown',
					contextWindow: model.contextWindow ?? 0, maxOutputTokens: model.maxOutputTokens ?? 0, capabilities,
					inputCostPer1M: model.pricing?.inputPerMillion ?? 0, outputCostPer1M: model.pricing?.outputPerMillion ?? 0,
					blurb: vscode.l10n.t("Discovered from {0}. Catalog access is verified separately from model inference; unreported capabilities and pricing remain unknown.", provider.name),
				};
			}
		}
	}

	private async verifyModel(modelId?: ModelId): Promise<void> {
		const snapshot = this.snapshot();
		const candidates = snapshot.providers.flatMap(provider => provider.models).filter(model => model.chat !== false && !['acp', 'claude-code', 'codex', 'copilot', 'bedrock'].includes(model.provider));
		const picked = modelId ? candidates.find(model => model.id === modelId) : await vscode.window.showQuickPick(candidates.map(model => ({ label: model.label, description: model.provider, id: model.id })), { title: vscode.l10n.t("Verify Model Tool Support"), placeHolder: vscode.l10n.t("One synthetic request, up to 256 output tokens and 30 seconds; provider charges may apply") });
		if (!picked) { return; }
		const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Verifying Tool Support") }, () => this.llmClient.verifyDiscoveredModel(picked.id));
		await this.service.captureAdvertisedModels();
		const updated = this.snapshot(); this.registerMetadata(updated); this.change.fire(updated);
		await vscode.window.showInformationMessage(result.message);
	}

	private async configureProvider(provider: string): Promise<void> {
		const secrets: Record<string, string> = { anthropic: 'anthropicApiKey', openai: 'openaiApiKey', google: 'googleApiKey', openrouter: 'openRouterApiKey', deepseek: 'deepSeekApiKey', mistral: 'mistralApiKey', groq: 'groqApiKey', cerebras: 'cerebrasApiKey', together: 'togetherApiKey', fireworks: 'fireworksApiKey', lmstudio: 'lmstudioApiKey', xai: 'xaiApiKey', moonshot: 'moonshotApiKey', zai: 'zaiApiKey', minimax: 'minimaxApiKey' };
		const secret = secrets[provider];
		const actions = [{ label: vscode.l10n.t("Open Provider Settings"), id: 'settings' }];
		if (secret) { actions.unshift({ label: vscode.l10n.t("Set API Key Securely"), id: 'key' }); }
		const action = await vscode.window.showQuickPick(actions, { title: vscode.l10n.t("Configure {0}", provider) });
		if (action?.id === 'key') {
			const value = await vscode.window.showInputBox({ title: vscode.l10n.t("Set {0} API Key", provider), password: true, ignoreFocusOut: true, prompt: vscode.l10n.t("Saved in the IDE secret storage. Existing credentials in other applications remain separate.") });
			if (value?.trim()) { await this.context.secrets.store(`sota.secrets.${secret}`, value.trim()); await this.refresh({ force: true }); }
		} else if (action?.id === 'settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', `sota ${provider === 'ollama' || provider === 'lmstudio' ? 'discovery.localServers' : provider === 'zai' ? 'zaiModels' : provider}`);
		}
	}

	private async showPicker(): Promise<void> {
		const snapshot = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t("Finding Coding Providers and Models") }, () => this.refresh({ force: true }));
		const items: Array<vscode.QuickPickItem & { modelId?: string; setup?: string; command?: string }> = [];
		for (const provider of snapshot.providers) {
			items.push({ label: provider.name, kind: vscode.QuickPickItemKind.Separator });
			if (!provider.models.length) { items.push({ label: provider.name, description: provider.catalogStatus, detail: provider.error ?? provider.catalogScope ?? vscode.l10n.t("No models discovered. Configure this provider or enable local server discovery."), setup: provider.id, command: ['acp', 'claude-code', 'codex'].includes(provider.id) ? 'sota.browseAcpAdapters' : undefined }); }
			if (provider.models.length) { items.push({ label: vscode.l10n.t("Configure {0}", provider.name), setup: provider.id }); }
			for (const model of provider.models) {
				items.push({ label: model.label, description: model.model, detail: model.chat === false ? vscode.l10n.t("Listed by provider; this model is not a chat model.") : vscode.l10n.t("Tools: {0} · Images: {1} · Pricing: {2}", String(model.tools), String(model.images), model.pricing ? vscode.l10n.t("Reported") : vscode.l10n.t("Unknown")), modelId: model.chat === false ? undefined : model.id });
			}
		}
		items.push({ label: vscode.l10n.t("Installed Coding Software"), kind: vscode.QuickPickItemKind.Separator });
		for (const software of snapshot.software.filter(item => item.installed || item.configFiles.length)) { items.push({ label: software.name, description: software.installed ? vscode.l10n.t("Installed") : vscode.l10n.t("Configuration Found"), detail: vscode.l10n.t("Sign-in file: {0}. Browse ACP adapters to configure an execution route.", software.auth), command: 'sota.browseAcpAdapters' }); }
		const choice = await vscode.window.showQuickPick(items, { title: vscode.l10n.t("Coding Providers and Models"), matchOnDescription: true, matchOnDetail: true, placeHolder: vscode.l10n.t("Select a model to use as the default in new chats") });
		if (choice?.command) { await vscode.commands.executeCommand(choice.command); return; }
		if (choice?.setup) { await this.configureProvider(choice.setup); return; }
		if (choice?.modelId) {
			const model = snapshot.providers.flatMap(provider => provider.models).find(entry => entry.id === choice.modelId);
			const actions = [{ label: vscode.l10n.t("Use as Default Model"), description: '', id: 'select' }];
			if (model && !['acp', 'claude-code', 'codex', 'copilot', 'bedrock'].includes(model.provider)) { actions.push({ label: vscode.l10n.t("Verify Tool Support"), description: vscode.l10n.t("One synthetic request; up to 256 output tokens; charges may apply"), id: 'verify' }); }
			const action = await vscode.window.showQuickPick(actions, { title: choice.label });
			if (!action) { return; }
			if (action.id === 'verify') { await this.verifyModel(choice.modelId as ModelId); return; }
			await vscode.workspace.getConfiguration('sota').update('defaultModel', choice.modelId, vscode.ConfigurationTarget.Global);
			await vscode.window.showInformationMessage(vscode.l10n.t("{0} will be used for new conversations.", choice.label));
		}
	}
}

export function activateProviderFinder(context: vscode.ExtensionContext, llmClient: LlmClient): ProviderFinder {
	const finder = new ProviderFinder(context, llmClient);
	context.subscriptions.push(finder);
	return finder;
}
