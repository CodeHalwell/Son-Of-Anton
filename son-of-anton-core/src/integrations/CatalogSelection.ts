/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import type { IntegrationEntry, SystemCatalog } from './SystemCatalog';
const selections = new Map<string, ReadonlySet<string>>();
/** Selection is set by the host after an explicit profile choice, never read from cloned workspace configuration. */
export function setCatalogSelection(workspace: string, ids: readonly string[] | undefined): void {
	if (ids) { selections.set(path.resolve(workspace), new Set(ids)); } else { selections.delete(path.resolve(workspace)); }
}
export function catalogEntrySelected(workspace: string | undefined, entry: IntegrationEntry, catalog: SystemCatalog): boolean {
	if (!entry.enabled) { return false; }
	const selected = workspace ? selections.get(path.resolve(workspace)) : undefined;
	if (!selected || selected.has(entry.id)) { return true; }
	return catalog.entries.some(plugin => plugin.kind === 'plugin' && plugin.enabled && selected.has(plugin.id) && entry.path.startsWith(plugin.path + path.sep));
}
