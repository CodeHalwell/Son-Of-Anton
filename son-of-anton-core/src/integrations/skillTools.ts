/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { Tool } from '../tools/types';
import { getSystemCatalog, readCatalogSkill } from './SystemCatalog';
import { catalogEntrySelected } from './CatalogSelection';

export const LIST_SKILLS_TOOL: Tool = {
	definition: {
		name: 'list_skills', category: 'read',
		description: 'Find installed skills from Claude, Codex, Cursor and shared agent folders. Search by task, then use read_skill for the selected instructions and bundled resources.',
		inputSchema: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer' } } },
	},
	async execute(input, ctx) {
		if (ctx.getConfigValue?.('sota.integrations.enabled') === false) { return { content: 'System integrations are disabled.', isError: true }; }
		const catalog = await getSystemCatalog({ workspace: ctx.workspaceRoot });
		const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
		const entries = catalog.entries.filter(entry => entry.kind === 'skill' && catalogEntrySelected(ctx.workspaceRoot, entry, catalog) && `${entry.name} ${entry.description} ${entry.source}`.toLowerCase().includes(query));
		const offset = typeof input.offset === 'number' && Number.isSafeInteger(input.offset) ? Math.max(0, input.offset) : 0;
		return { content: JSON.stringify({ total: entries.length, nextOffset: offset + 50 < entries.length ? offset + 50 : undefined, skills: entries.slice(offset, offset + 50).map(({ id, name, description, source, scope }) => ({ id, name, description, source, scope })) }) };
	},
};
export const READ_SKILL_TOOL: Tool = {
	definition: {
		name: 'read_skill', category: 'read',
		description: 'Read the SKILL.md of a discovered skill, or a relative bundled resource it references. Use the exact id from list_skills. Read relevant instructions before applying a skill; source-app-only tools may be unavailable.',
		inputSchema: { type: 'object', properties: { id: { type: 'string' }, resource: { type: 'string', description: 'Path relative to the skill directory; defaults to SKILL.md.' } }, required: ['id'] },
	},
	async execute(input, ctx) {
		if (ctx.getConfigValue?.('sota.integrations.enabled') === false) { return { content: 'System integrations are disabled.', isError: true }; }
		if (typeof input.id !== 'string') { return { content: 'A discovered skill id is required.', isError: true }; }
		try {
			const catalog = await getSystemCatalog({ workspace: ctx.workspaceRoot });
			const entry = catalog.entries.find(entry => entry.id === input.id);
			if (!entry || !catalogEntrySelected(ctx.workspaceRoot, entry, catalog)) { return { content: 'This skill is not enabled in the active integration profile.', isError: true }; }
			return { content: await readCatalogSkill(catalog, input.id, typeof input.resource === 'string' ? input.resource : undefined) };
		} catch (error) { return { content: error instanceof Error ? error.message : 'Could not read skill', isError: true }; }
	},
};
