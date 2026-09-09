/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getSpecialist, SPECIALIST_ROLES } from 'son-of-anton-core/chat/specialistRegistry';
import { getDiscoveredModel } from 'son-of-anton-core/llm/DiscoveredModels';
import type { ModelId } from 'son-of-anton-core/llm/LlmClient';
import type { AgentBridge } from './AgentBridge';

/** Resolve the exact catalog route without starting an adapter or changing its selected model. */
export function resolveChatSpecialist(model: ModelId, requested: string, bridge?: Pick<AgentBridge, 'hasAgent' | 'getCapabilities'>): string {
	if (!model.startsWith('catalog:acp:')) { return getSpecialist(requested) ? requested : 'anton'; }
	const discovered = getDiscoveredModel(model);
	if (!discovered || discovered.provider !== 'acp' || !discovered.acpAdapterId || discovered.chat === false) {
		throw new Error(vscode.l10n.t('The selected ACP model is unavailable. Refresh Anton: Find Providers and Models, then select an available model.'));
	}
	// Direct-only and removed personas cannot execute ACP. Prefer the user's
	// specialist, then the general coding specialist, then another registered
	// specialist that actually resolves this adapter (not merely any ACP route).
	for (const id of new Set([requested, 'anton-code', ...SPECIALIST_ROLES.map(role => role.id)])) {
		if (id === 'anton' || !bridge?.hasAgent(id)) { continue; }
		const capability = bridge.getCapabilities(id, model);
		if (capability.transport === 'acp' && !capability.error) { return id; }
	}
	throw new Error(vscode.l10n.t('The selected ACP model needs a configured agent adapter. Open Anton: Browse ACP Adapters, then select the model again or choose a native model.'));
}
