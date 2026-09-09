/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IntegrationEntry, SystemCatalog } from 'son-of-anton-core/integrations/SystemCatalog';
import { discoveredAcpModelId, discoveredModelId, type CatalogProvider } from 'son-of-anton-core/llm/DiscoveredModels';
import { isValidAcpModelId } from 'son-of-anton-core/acp/protocol';
import type { AgentHandle } from 'son-of-anton-core/agents/types';

export interface IntegrationProfile {
	id: string;
	name: string;
	entryIds: string[];
	/** Configuration values only. Launch descriptors and credentials remain in their source settings. */
	routes: Record<string, string>;
	updatedAt: number;
}
export interface IntegrationProfiles { version: 1; activeId?: string; profiles: IntegrationProfile[] }

// Exhaustiveness makes new runtime specialists a deliberate profile migration decision.
const profileAgents: Record<AgentHandle, true> = {
	anton: true, 'anton-code': true, 'anton-test': true, 'anton-e2e': true,
	'anton-security': true, 'anton-pentest': true, 'anton-docs': true, 'anton-ci': true,
	'anton-pr': true, 'anton-moderniser': true, 'anton-review': true, 'anton-spec': true,
};

/** Model limits apply before catalog encoding; ACP adapter identifiers have no length cap. */
function isIntegrationRoute(key: string, value: unknown): value is string {
	const field = /^sota\.agents\.[\w-]+\.(model|acpAgent)$/.exec(key)?.[1];
	if (!field || typeof value !== 'string') { return false; }
	const route = value.trim();
	if (field === 'acpAgent') { return !/[\u0000-\u001f\u007f]/.test(route); }
	if (!route.startsWith('catalog:')) { return value.length <= 200; }
	const match = /^catalog:([^:]+):(.*)$/u.exec(route); if (!match) { return false; }
	try {
		const provider = match[1] as CatalogProvider, decoded = decodeURIComponent(match[2]);
		if (provider !== 'acp') { return discoveredModelId(provider, decoded) === route; }
		// Older ACP catalog entries may omit an adapter namespace.
		if (isValidAcpModelId(decoded) && discoveredModelId('acp', decoded) === route) { return true; }
		if (/[\u0000-\u001f\u007f]/.test(decoded)) { return false; }
		// Both adapter and model IDs may contain '/'. Only a model suffix of
		// at most 512 raw characters is constrained, so inspect those separators.
		const firstNonWhitespace = decoded.search(/\S/);
		for (let separator = decoded.indexOf('/', Math.max(1, decoded.length - 513)); separator !== -1; separator = decoded.indexOf('/', separator + 1)) {
			if (firstNonWhitespace >= 0 && firstNonWhitespace < separator && isValidAcpModelId(decoded.slice(separator + 1))) {
				return discoveredAcpModelId(decoded.slice(0, separator), decoded.slice(separator + 1)) === route;
			}
		}
	} catch { /* Malformed or noncanonical stored identifiers cannot become routes. */ }
	return false;
}

/** Capture the complete current route set, including routes absent from older saved profiles. */
export function captureIntegrationRoutes(read: (key: string) => unknown): Record<string, string> {
	const routes: Record<string, string> = {};
	for (const agent of Object.keys(profileAgents)) {
		for (const field of ['model', 'acpAgent']) {
			const key = `sota.agents.${agent}.${field}`, value = read(key);
			if (isIntegrationRoute(key, value)) { routes[key] = value; }
		}
	}
	return routes;
}

/** Persisted host state is still validated so older or corrupted records cannot become routes. */
export function readProfiles(raw: unknown): IntegrationProfiles {
	const value = raw as Partial<IntegrationProfiles> | undefined;
	if (value?.version !== 1 || !Array.isArray(value.profiles)) { return { version: 1, profiles: [] }; }
	const profiles = value.profiles.filter(profile => profile && typeof profile.id === 'string' && /^[\w-]{1,80}$/.test(profile.id) && typeof profile.name === 'string' && profile.name.length <= 100 && Array.isArray(profile.entryIds)).map(profile => ({
		...profile,
		entryIds: [...new Set(profile.entryIds.filter(id => typeof id === 'string'))].slice(0, 2000),
		routes: Object.fromEntries(Object.entries(profile.routes ?? {}).filter(([key, value]) => isIntegrationRoute(key, value))),
	}));
	return { version: 1, profiles, activeId: profiles.some(profile => profile.id === value.activeId) ? value.activeId : undefined };
}

/** Duplicate names retain their origin; disabled source entries cannot be activated by a profile. */
export function integrationConflicts(catalog: SystemCatalog): IntegrationEntry[][] {
	const names = new Map<string, IntegrationEntry[]>();
	for (const entry of catalog.entries) {
		const key = `${entry.kind}:${entry.name.toLowerCase()}`;
		names.set(key, [...(names.get(key) ?? []), entry]);
	}
	return [...names.values()].filter(entries => entries.length > 1);
}
