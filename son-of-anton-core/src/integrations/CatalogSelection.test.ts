/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogEntrySelected, setCatalogSelection } from './CatalogSelection';
import type { IntegrationEntry, SystemCatalog } from './SystemCatalog';

test('workspace profiles enforce skill selection and preserve source disables and plugin directory boundaries', () => {
	const workspace = '/selection-test';
	const plugin: IntegrationEntry = { id: 'plugin', kind: 'plugin', name: 'Plugin', source: 'codex', scope: 'user', path: '/plugins/demo', enabled: true, description: '' };
	const skill: IntegrationEntry = { ...plugin, id: 'skill', kind: 'skill', path: '/plugins/demo/skills/test/SKILL.md' };
	const catalog: SystemCatalog = { entries: [plugin, skill], servers: new Map(), issues: [] };
	setCatalogSelection(workspace, ['plugin']);
	try {
		assert.deepEqual([
			catalogEntrySelected(workspace, skill, catalog), catalogEntrySelected(workspace, { ...skill, enabled: false }, catalog),
			catalogEntrySelected(workspace, { ...skill, path: '/plugins/demo-other/SKILL.md' }, catalog), catalogEntrySelected('/other', skill, catalog),
		], [true, false, false, true]);
		setCatalogSelection(workspace, []); assert.equal(catalogEntrySelected(workspace, skill, catalog), false);
	} finally { setCatalogSelection(workspace, undefined); }
});
