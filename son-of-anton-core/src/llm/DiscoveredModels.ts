/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type CatalogProvider = 'anthropic' | 'openai' | 'google' | 'openrouter' | 'ollama' | 'lmstudio' | 'deepseek' | 'mistral' | 'groq' | 'cerebras' | 'together' | 'fireworks' | 'foundry' | 'bedrock' | 'acp' | 'claude-code' | 'codex' | 'copilot' | 'xai' | 'moonshot' | 'zai' | 'minimax';
export type DiscoveredModelId = `catalog:${CatalogProvider}:${string}`;
export type CapabilityAvailability = boolean | 'unknown';
export interface DiscoveredModel {
	id: DiscoveredModelId;
	provider: CatalogProvider;
	acpAdapterId?: string;
	model: string;
	label: string;
	chat: CapabilityAvailability;
	images: CapabilityAvailability;
	tools: CapabilityAvailability;
	contextWindow?: number;
	maxOutputTokens?: number;
	pricing?: { inputPerMillion: number; outputPerMillion: number };
	fetchedAt: number;
	capabilitySource?: 'catalog-reported' | 'verified';
	verifiedAt?: number;
}

const providers = new Set<CatalogProvider>(['anthropic', 'openai', 'google', 'openrouter', 'ollama', 'lmstudio', 'deepseek', 'mistral', 'groq', 'cerebras', 'together', 'fireworks', 'foundry', 'bedrock', 'acp', 'claude-code', 'codex', 'copilot', 'xai', 'moonshot', 'zai', 'minimax']);
const models = new Map<string, DiscoveredModel>();
const listeners = new Set<() => void>();
export function onDiscoveredModelsChanged(listener: () => void): { dispose(): void } { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; }
export function discoveredAcpModels(): DiscoveredModel[] { return [...models.values()].filter(model => model.provider === 'acp').map(model => ({ ...model })); }

export function discoveredModelId(provider: CatalogProvider, model: string): DiscoveredModelId {
	if (!providers.has(provider) || !model || model.length > 512 || /[\u0000-\u001f\u007f]/.test(model)) { throw new Error('Invalid provider model identifier'); }
	return `catalog:${provider}:${encodeURIComponent(model)}`;
}

/** Only catalog entries received through discovery can become executable model routes. */
export function registerDiscoveredModels(entries: readonly DiscoveredModel[]): void {
	let changed = false;
	for (const model of entries.slice(0, 10000)) {
		try {
			const identifier = model.acpAdapterId ? `${model.acpAdapterId}/${model.model}` : model.model;
			if (!providers.has(model.provider) || model.id !== discoveredModelId(model.provider, identifier)
				|| ![true, false, 'unknown'].includes(model.chat) || ![true, false, 'unknown'].includes(model.images) || ![true, false, 'unknown'].includes(model.tools)) { continue; }
			const previous = models.get(model.id);
			const value = previous?.capabilitySource === 'verified' && previous.verifiedAt && Date.now() - previous.verifiedAt < 24 * 60 * 60 * 1000 && model.tools === 'unknown' ? { ...model, tools: previous.tools, capabilitySource: previous.capabilitySource, verifiedAt: previous.verifiedAt } : { ...model };
			models.set(model.id, value);
			changed ||= JSON.stringify(previous) !== JSON.stringify(value);
		} catch { /* Malformed cached/catalog entries must not break activation. */ }
	}
	if (changed) { for (const listener of listeners) { try { listener(); } catch { /* Observer errors do not break model execution. */ } } }
}

export function getDiscoveredModel(id: string): DiscoveredModel | undefined { return models.get(id); }

export function markDiscoveredToolsVerified(id: string): void {
	const model = models.get(id);
	if (model) { registerDiscoveredModels([{ ...model, tools: true, capabilitySource: 'verified', verifiedAt: Date.now() }]); }
}
