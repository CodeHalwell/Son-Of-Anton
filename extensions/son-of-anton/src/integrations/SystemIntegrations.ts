/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { getSystemCatalog, type IntegrationEntry, type ImportedMcpServer } from 'son-of-anton-core/integrations/SystemCatalog';

export interface SystemIntegrationsState {
	entries: Array<IntegrationEntry & { configured: boolean; state?: string }>;
	issues: Array<{ path: string; message: string }>;
}
const options = () => ({ workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
const selected = (): string[] => {
	const value = vscode.workspace.getConfiguration('sota').inspect<unknown>('integrations.mcpServers')?.globalValue;
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
};
export async function importedMcpServers(): Promise<ImportedMcpServer[]> {
	if (vscode.workspace.getConfiguration('sota').get<boolean>('integrations.enabled', true) === false) { return []; }
	const catalog = await getSystemCatalog(options());
	return selected().flatMap(id => { const server = catalog.servers.get(id); return server ? [server] : []; });
}
export function registerSystemIntegrations(context: vscode.ExtensionContext, reconcile: () => void, states: Map<string, string>): void {
	context.subscriptions.push(vscode.commands.registerCommand('sota.systemIntegrations', async (action: string = 'list', id?: string) => {
		const catalog = await getSystemCatalog(options(), action === 'refresh');
		const entry = catalog.entries.find(entry => entry.id === id);
		if (action === 'open' && entry) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.path));
		} else if (action === 'connect' && entry?.kind === 'mcp' && catalog.servers.has(entry.id)) {
			await vscode.workspace.getConfiguration('sota').update('integrations.mcpServers', [...new Set([...selected(), entry.id])], vscode.ConfigurationTarget.Global);
		} else if (action === 'disconnect' && entry?.kind === 'mcp') {
			await vscode.workspace.getConfiguration('sota').update('integrations.mcpServers', selected().filter(value => value !== entry.id), vscode.ConfigurationTarget.Global);
		}
		if (action !== 'list' && action !== 'open') { reconcile(); }
		const ids = new Set(selected());
		return {
			entries: catalog.entries.map(entry => ({ ...entry, configured: ids.has(entry.id), state: ids.has(entry.id) && entry.enabled ? states.get(catalog.servers.get(entry.id)?.name ?? '') : undefined })),
			issues: catalog.issues,
		} satisfies SystemIntegrationsState;
	}));
}
