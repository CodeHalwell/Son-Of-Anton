/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { randomUUID, createHash } from 'node:crypto';
import { getSystemCatalog, type IntegrationEntry, type ImportedMcpServer } from 'son-of-anton-core/integrations/SystemCatalog';
import { setCatalogSelection } from 'son-of-anton-core/integrations/CatalogSelection';
import { captureIntegrationRoutes, integrationConflicts, readProfiles, type IntegrationProfiles } from './IntegrationProfiles';

export interface SystemIntegrationsState {
	entries: Array<IntegrationEntry & { configured: boolean; state?: string }>;
	issues: Array<{ path: string; message: string }>;
	profile?: string;
}
const options = () => ({ workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
const globalSelected = (): string[] => {
	const value = vscode.workspace.getConfiguration('sota').inspect<unknown>('integrations.mcpServers')?.globalValue;
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
};
let profiles: IntegrationProfiles = { version: 1, profiles: [] };
const active = () => profiles.profiles.find(profile => profile.id === profiles.activeId);
/** Used by live host configuration wrappers. No routes are applied in Restricted Mode. */
export function integrationProfileValue(key: string): string | undefined {
	return vscode.workspace.isTrusted ? active()?.routes[key] : undefined;
}
export async function importedMcpServers(): Promise<ImportedMcpServer[]> {
	if (!vscode.workspace.isTrusted || vscode.workspace.getConfiguration('sota').get<boolean>('integrations.enabled', true) === false) { return []; }
	const catalog = await getSystemCatalog(options());
	const ids = active()?.entryIds ?? globalSelected();
	return catalog.entries.filter(entry => entry.kind === 'mcp' && entry.enabled && ids.includes(entry.id))
		.flatMap(entry => { const server = catalog.servers.get(entry.id); return server ? [server] : []; });
}
export function registerSystemIntegrations(context: vscode.ExtensionContext, reconcile: () => void, states: Map<string, string>): void {
	const storageKey = () => `sota.integrationProfiles.v1.${createHash('sha256').update(options().workspace ?? '').digest('hex')}`;
	profiles = readProfiles(context.workspaceState.get(storageKey()));
	let workspace = options().workspace, disposed = false, scanning = false, fingerprint: string | undefined;
	let changes: string[] = [];
	let previousEntries = new Map<string, IntegrationEntry>();
	const apply = () => { if (workspace) { setCatalogSelection(workspace, active()?.entryIds); } reconcile(); };
	if (workspace) { setCatalogSelection(workspace, active()?.entryIds); }
	const save = async () => { await context.workspaceState.update(storageKey(), profiles); apply(); };
	context.subscriptions.push({ dispose: () => { disposed = true; if (workspace) { setCatalogSelection(workspace, undefined); } profiles = { version: 1, profiles: [] }; } });
	const refresh = async (): Promise<void> => {
		if (scanning || disposed || !vscode.workspace.getConfiguration('sota').get('integrations.enabled', true)) { return; }
		scanning = true;
		try {
			const catalog = await getSystemCatalog(options(), true);
			const next = createHash('sha256').update(JSON.stringify([catalog.entries, [...catalog.servers]])).digest('hex');
			if (fingerprint && next !== fingerprint && !disposed) {
				const current = new Map(catalog.entries.map(entry => [entry.id, entry]));
				changes = [vscode.l10n.t('Source configuration changed at {0}. Active selections were reconciled; source disables and MCP trust still apply.', new Date().toLocaleTimeString())];
				for (const entry of catalog.entries) {
					const previous = previousEntries.get(entry.id);
					if (!previous) { changes.push(vscode.l10n.t('Added: {0} / {1} / {2}', entry.source, entry.name, entry.path)); }
					else if (JSON.stringify(previous) !== JSON.stringify(entry)) { changes.push(vscode.l10n.t('Changed: {0} / {1} — version {2} → {3}, enabled {4} → {5}', entry.source, entry.name, previous.version ?? '—', entry.version ?? '—', previous.enabled, entry.enabled)); }
				}
				for (const previous of previousEntries.values()) { if (!current.has(previous.id)) { changes.push(vscode.l10n.t('Removed: {0} / {1} / {2}', previous.source, previous.name, previous.path)); } }
				changes = changes.slice(0, 200); apply();
			}
			previousEntries = new Map(catalog.entries.map(entry => [entry.id, { ...entry }]));
			fingerprint = next;
		} catch { changes = [vscode.l10n.t('Integration refresh failed. Open integration settings to retry.')]; }
		finally { scanning = false; }
	};
	const timer = setInterval(() => void refresh(), 60_000);
	context.subscriptions.push({ dispose: () => clearInterval(timer) });
	void refresh();
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
		if (workspace) { setCatalogSelection(workspace, undefined); }
		workspace = options().workspace; profiles = readProfiles(context.workspaceState.get(storageKey())); apply(); void refresh();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('sota.systemIntegrations', async (action: string = 'list', id?: string) => {
		const catalog = await getSystemCatalog(options(), action === 'refresh');
		const entry = catalog.entries.find(entry => entry.id === id);
		if (action === 'open' && entry) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.path)); }
		else if (entry?.kind === 'mcp' && (action === 'disconnect' || action === 'connect' && entry.enabled && catalog.servers.has(entry.id))) {
			const ids = active()?.entryIds ?? globalSelected();
			const next = action === 'connect' ? [...new Set([...ids, entry.id])] : ids.filter(value => value !== entry.id);
			const profile = active();
			if (profile) { profile.entryIds = next; profile.updatedAt = Date.now(); await save(); }
			else { await vscode.workspace.getConfiguration('sota').update('integrations.mcpServers', next, vscode.ConfigurationTarget.Global); }
		}
		if (action !== 'list' && action !== 'open') { reconcile(); }
		const ids = new Set(active()?.entryIds ?? globalSelected());
		return { entries: catalog.entries.map(entry => ({ ...entry, configured: ids.has(entry.id), state: ids.has(entry.id) && entry.enabled ? states.get(catalog.servers.get(entry.id)?.name ?? '') : undefined })), issues: catalog.issues, profile: active()?.name } satisfies SystemIntegrationsState;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('sota.integrationChanges', async () => {
		await refresh();
		const catalog = await getSystemCatalog(options());
		const content = [vscode.l10n.t('Integration Sources and Conflicts'), '', ...changes, ...catalog.issues.map(issue => `${issue.path}: ${issue.message}`), ...integrationConflicts(catalog).flatMap(entries => ['', vscode.l10n.t('Duplicate {0}: {1}', entries[0].kind, entries[0].name), ...entries.map(entry => `${entry.source} / ${entry.scope} / ${entry.version ?? '—'} / ${entry.enabled ? 'enabled' : 'disabled'} — ${entry.path}`)])].join('\n');
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content, language: 'plaintext' }));
	}));
	context.subscriptions.push(vscode.commands.registerCommand('sota.manageIntegrationProfiles', async () => {
		if (!workspace) { await vscode.window.showInformationMessage(vscode.l10n.t('Open a project to manage integration profiles.')); return; }
		const pick = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Create Profile from Current Configuration'), action: 'create', id: '' },
			{ label: vscode.l10n.t('Use Global Integration Configuration'), action: 'global', id: '' },
			...profiles.profiles.map(profile => ({ label: profile.name, description: profile.id === profiles.activeId ? vscode.l10n.t('Active') : '', action: 'profile', id: profile.id })),
		], { title: vscode.l10n.t('Project Integration Profiles') });
		if (!pick) { return; }
		if (pick.action === 'global') { profiles.activeId = undefined; await save(); return; }
		if (pick.action === 'create') {
			const name = await vscode.window.showInputBox({ title: vscode.l10n.t('Profile Name'), validateInput: value => !value.trim() || value.length > 100 ? vscode.l10n.t('Use 1–100 characters.') : undefined });
			if (!name) { return; }
			const catalog = await getSystemCatalog(options()), current = active();
			const routes = captureIntegrationRoutes(key => current?.routes[key] ?? vscode.workspace.getConfiguration().get(key));
			const profile = { id: randomUUID(), name: name.trim(), entryIds: current?.entryIds.slice() ?? [...catalog.entries.filter(entry => entry.enabled && entry.kind !== 'mcp').map(entry => entry.id), ...globalSelected()], routes, updatedAt: Date.now() };
			profiles.profiles.push(profile); profiles.activeId = profile.id; await save(); return;
		}
		const profile = profiles.profiles.find(profile => profile.id === pick.id)!;
		const operation = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Activate'), action: 'activate' }, { label: vscode.l10n.t('Edit Skills, Plugins and MCP Servers'), action: 'entries' },
			{ label: vscode.l10n.t('Capture Current Agent Routes'), action: 'routes' }, { label: vscode.l10n.t('Delete Profile'), action: 'delete' },
		], { title: profile.name });
		if (!operation) { return; }
		if (operation.action === 'activate') { profiles.activeId = profile.id; }
		else if (operation.action === 'delete') { profiles.profiles = profiles.profiles.filter(entry => entry.id !== profile.id); if (profiles.activeId === profile.id) { profiles.activeId = undefined; } }
		else if (operation.action === 'routes') {
			profile.routes = captureIntegrationRoutes(key => vscode.workspace.getConfiguration().get(key));
		} else {
			const catalog = await getSystemCatalog(options());
			const entries = await vscode.window.showQuickPick(catalog.entries.filter(entry => entry.enabled).map(entry => ({ label: `${entry.name} (${entry.kind})`, description: `${entry.source} · ${entry.scope}`, detail: entry.path, picked: profile.entryIds.includes(entry.id), id: entry.id })), { canPickMany: true, title: vscode.l10n.t('Select Profile Capabilities'), placeHolder: vscode.l10n.t('MCP connections still require workspace and server trust. Source-disabled entries are excluded.') });
			if (!entries) { return; } profile.entryIds = entries.map(entry => entry.id);
		}
		profile.updatedAt = Date.now(); await save();
	}));
}
