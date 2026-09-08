/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { IntegrationEntry, SystemCatalog } from 'son-of-anton-core/integrations/SystemCatalog';
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

/** Capture the complete current route set, including routes absent from older saved profiles. */
export function captureIntegrationRoutes(read: (key: string) => unknown): Record<string, string> {
	const routes: Record<string, string> = {};
	for (const agent of Object.keys(profileAgents)) {
		for (const field of ['model', 'acpAgent']) {
			const key = `sota.agents.${agent}.${field}`, value = read(key);
			if (typeof value === 'string' && value.length <= 200) { routes[key] = value; }
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
		routes: Object.fromEntries(Object.entries(profile.routes ?? {}).filter(([key, value]) => /^sota\.agents\.[\w-]+\.(model|acpAgent)$/.test(key) && typeof value === 'string' && value.length <= 200)),
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
