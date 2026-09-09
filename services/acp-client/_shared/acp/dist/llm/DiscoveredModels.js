"use strict";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.onDiscoveredModelsChanged = onDiscoveredModelsChanged;
exports.discoveredAcpModels = discoveredAcpModels;
exports.discoveredModelId = discoveredModelId;
exports.discoveredAcpModelId = discoveredAcpModelId;
exports.registerDiscoveredModels = registerDiscoveredModels;
exports.replaceDiscoveredModels = replaceDiscoveredModels;
exports.getDiscoveredModel = getDiscoveredModel;
exports.markDiscoveredToolsVerified = markDiscoveredToolsVerified;
const protocol_1 = require("../acp/protocol");
const providers = new Set(['anthropic', 'openai', 'google', 'openrouter', 'ollama', 'lmstudio', 'deepseek', 'mistral', 'groq', 'cerebras', 'together', 'fireworks', 'foundry', 'bedrock', 'acp', 'claude-code', 'codex', 'copilot', 'xai', 'moonshot', 'zai', 'minimax']);
const models = new Map();
const listeners = new Set();
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