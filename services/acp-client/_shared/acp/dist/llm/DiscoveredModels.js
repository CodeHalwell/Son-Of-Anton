"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAcpCatalogPolicy = createAcpCatalogPolicy;
exports.beginAcpModelCatalog = beginAcpModelCatalog;
exports.onDiscoveredModelsChanged = onDiscoveredModelsChanged;
exports.discoveredAcpModels = discoveredAcpModels;
exports.discoveredModelId = discoveredModelId;
exports.discoveredAcpModelId = discoveredAcpModelId;
exports.registerDiscoveredModels = registerDiscoveredModels;
exports.replaceDiscoveredModels = replaceDiscoveredModels;
exports.getDiscoveredModel = getDiscoveredModel;
exports.markDiscoveredToolsVerified = markDiscoveredToolsVerified;
const node_crypto_1 = require("node:crypto");
const protocol_1 = require("../acp/protocol");
const providers = new Set(['anthropic', 'openai', 'google', 'openrouter', 'ollama', 'lmstudio', 'deepseek', 'mistral', 'groq', 'cerebras', 'together', 'fireworks', 'foundry', 'bedrock', 'acp', 'claude-code', 'codex', 'copilot', 'xai', 'moonshot', 'zai', 'minimax']);
const models = new Map();
const listeners = new Set();
let acpCatalogPolicy;
let acpCatalogGeneration = 0;
function acpAdapterFingerprint(agent) {
    // These model selections are legitimate per-turn overlays of the configured adapter.
    const env = Object.fromEntries(Object.entries(agent.env ?? {}).filter(([key]) => key !== 'ANTHROPIC_MODEL').sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
    return (0, node_crypto_1.createHash)('sha256').update(JSON.stringify([agent.id, agent.command, agent.args ?? [], env, agent.authMethodId ?? ''])).digest('hex');
}
/** An IDE catalog owns its current validated adapter scopes; standalone runtimes need no policy. */
function createAcpCatalogPolicy() {
    const policy = { scopes: acpCatalogPolicy?.scopes };
    acpCatalogPolicy = policy;
    return {
        update: agents => {
            const next = new Map();
            for (const agent of agents) {
                (0, protocol_1.validateAgent)(agent);
                discoveredAcpModelId(agent.id, 'scope-validation');
                if (next.has(agent.id)) {
                    throw new Error('Duplicate ACP adapter ID');
                }
                const fingerprint = acpAdapterFingerprint(agent), previous = policy.scopes?.get(agent.id);
                next.set(agent.id, previous?.fingerprint === fingerprint ? previous : { fingerprint, generation: ++acpCatalogGeneration });
            }
            policy.scopes = next;
            if (acpCatalogPolicy !== policy) {
                return;
            }
            let changed = false;
            for (const [id, model] of models) {
                if (model.provider === 'acp' && !acpModelAllowed(model)) {
                    models.delete(id);
                    changed = true;
                }
            }
            if (changed) {
                notifyChanged();
            }
        },
        dispose: () => { if (acpCatalogPolicy === policy) {
            acpCatalogPolicy = undefined;
        } },
    };
}
function acpModelAllowed(model) {
    const scopes = acpCatalogPolicy?.scopes;
    const scope = model.acpAdapterId ? scopes?.get(model.acpAdapterId) : undefined;
    return scopes === undefined || scope !== undefined && scope.fingerprint === model.acpAdapterFingerprint;
}
/** Capture before queueing/negotiation so a removed or replaced adapter cannot republish late. */
function beginAcpModelCatalog(agent) {
    const fingerprint = acpAdapterFingerprint(agent);
    const initialScopes = acpCatalogPolicy?.scopes;
    const scope = initialScopes?.get(agent.id);
    return (entries, truncated) => {
        const currentScopes = acpCatalogPolicy?.scopes;
        if (initialScopes === undefined ? currentScopes !== undefined : !scope || scope.fingerprint !== fingerprint || currentScopes?.get(agent.id)?.generation !== scope.generation) {
            return;
        }
        const advertised = entries.map(model => ({ ...model, acpAdapterFingerprint: fingerprint }));
        if (truncated) {
            registerDiscoveredModels(advertised);
        }
        else {
            replaceDiscoveredModels({ provider: 'acp', acpAdapterId: agent.id }, advertised);
        }
    };
}
function onDiscoveredModelsChanged(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; }
function discoveredAcpModels() { return [...models.values()].filter(model => model.provider === 'acp').map(model => ({ ...model })); }
function discoveredModelId(provider, model) {
    if (!providers.has(provider) || !model || model.length > 512 || /[\u0000-\u001f\u007f]/.test(model)) {
        throw new Error('Invalid provider model identifier');
    }
    return `catalog:${provider}:${encodeURIComponent(model)}`;
}
/** Preserve the catalog namespace without counting its adapter prefix against the raw ID limit. */
function discoveredAcpModelId(adapterId, model) {
    if (typeof adapterId !== 'string' || !adapterId.trim() || /[\u0000-\u001f\u007f]/.test(adapterId) || !(0, protocol_1.isValidAcpModelId)(model)) {
        throw new Error('Invalid ACP model identifier');
    }
    return `catalog:acp:${encodeURIComponent(`${adapterId}/${model}`)}`;
}
/** Only catalog entries received through discovery can become executable model routes. */
function registerDiscoveredModels(entries) {
    let changed = false;
    for (const model of entries.slice(0, 10000)) {
        const value = validatedModel(model);
        if (!value) {
            continue;
        }
        changed ||= JSON.stringify(models.get(value.id)) !== JSON.stringify(value);
        models.set(value.id, value);
    }
    if (changed) {
        notifyChanged();
    }
}
/** Replace only a complete, authoritative catalog; failed/partial refreshes must use cached entries. */
function replaceDiscoveredModels(scope, entries) {
    if (!providers.has(scope.provider) || entries.length > 10000) {
        throw new Error('Invalid replacement model catalog');
    }
    if (scope.provider === 'acp') {
        discoveredAcpModelId(scope.acpAdapterId, 'scope-validation');
    }
    if (scope.provider === 'acp' && acpCatalogPolicy?.scopes && !acpCatalogPolicy.scopes.has(scope.acpAdapterId)) {
        return;
    }
    const owns = (model) => model.provider === scope.provider && (scope.provider !== 'acp' || model.acpAdapterId === scope.acpAdapterId);
    const next = new Map();
    for (const model of entries) {
        const value = validatedModel(model);
        if (!value || !owns(value)) {
            throw new Error('Replacement model catalog contains an invalid or unrelated entry');
        }
        next.set(value.id, value);
    }
    let changed = false;
    for (const [id, model] of models) {
        if (owns(model) && !next.has(id)) {
            models.delete(id);
            changed = true;
        }
    }
    for (const [id, model] of next) {
        changed ||= JSON.stringify(models.get(id)) !== JSON.stringify(model);
        models.set(id, model);
    }
    if (changed) {
        notifyChanged();
    }
}
function validatedModel(model) {
    try {
        const identifier = model.provider === 'acp' && model.acpAdapterId !== undefined
            ? discoveredAcpModelId(model.acpAdapterId, model.model)
            : discoveredModelId(model.provider, model.acpAdapterId ? `${model.acpAdapterId}/${model.model}` : model.model);
        if (!providers.has(model.provider) || model.id !== identifier
            || model.provider === 'acp' && !acpModelAllowed(model)
            || model.acpAdapterFingerprint !== undefined && (typeof model.acpAdapterFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(model.acpAdapterFingerprint))
            || model.modelFamily !== undefined && (typeof model.modelFamily !== 'string' || !model.modelFamily || model.modelFamily.length > 512 || /[\u0000-\u001f\u007f]/.test(model.modelFamily))
            || ![true, false, 'unknown'].includes(model.chat) || ![true, false, 'unknown'].includes(model.images) || ![true, false, 'unknown'].includes(model.tools)) {
            return undefined;
        }
        const previous = models.get(model.id);
        return previous?.modelFamily === model.modelFamily && previous?.capabilitySource === 'verified' && previous.verifiedAt && Date.now() - previous.verifiedAt < 24 * 60 * 60 * 1000 && model.tools === 'unknown'
            ? { ...model, tools: previous.tools, capabilitySource: previous.capabilitySource, verifiedAt: previous.verifiedAt } : { ...model };
    }
    catch {
        return undefined; /* Malformed cached/catalog entries must not break activation. */
    }
}
function notifyChanged() {
    for (const listener of listeners) {
        try {
            listener();
        }
        catch { /* Observer errors do not break model execution. */ }
    }
}
function getDiscoveredModel(id) { return models.get(id); }
function markDiscoveredToolsVerified(id) {
    const model = models.get(id);
    if (model) {
        registerDiscoveredModels([{ ...model, tools: true, capabilitySource: 'verified', verifiedAt: Date.now() }]);
    }
}
//# sourceMappingURL=DiscoveredModels.js.map