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
    pricing?: {
        inputPerMillion: number;
        outputPerMillion: number;
    };
    fetchedAt: number;
    capabilitySource?: 'catalog-reported' | 'verified';
    verifiedAt?: number;
}
export declare function onDiscoveredModelsChanged(listener: () => void): {
    dispose(): void;
};
export declare function discoveredAcpModels(): DiscoveredModel[];
export declare function discoveredModelId(provider: CatalogProvider, model: string): DiscoveredModelId;
/** Preserve the catalog namespace without counting its adapter prefix against the raw ID limit. */
export declare function discoveredAcpModelId(adapterId: string, model: string): DiscoveredModelId;
/** Only catalog entries received through discovery can become executable model routes. */
export declare function registerDiscoveredModels(entries: readonly DiscoveredModel[]): void;
export declare function getDiscoveredModel(id: string): DiscoveredModel | undefined;
export declare function markDiscoveredToolsVerified(id: string): void;
//# sourceMappingURL=DiscoveredModels.d.ts.map