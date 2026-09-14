/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { AgentManager } from 'son-of-anton-core/agents/AgentManager';
import { CredentialBroker } from 'son-of-anton-core/auth/CredentialBroker';
import type { ProviderStatus } from 'son-of-anton-core/auth/types';
import { detectCredentials, hasAnyProvider } from 'son-of-anton-core/credentials/credentialDetection';
import { isClaudeCodeAvailable } from 'son-of-anton-core/llm/claudeCodeRunner';
import { isCodexAvailable } from 'son-of-anton-core/llm/codexRunner';

/**
 * Manages the status bar items for Son of Anton.
 *
 * Layout decision: TWO side-by-side left-aligned status bar items rather than
 * one combined entry.
 *  - The agent item (priority 100) keeps its existing click target
 *    (sota.openChat) and behaviour (spinner / hubot icon depending on whether
 *    any agent task is running).
 *  - The auth item (priority 99) is independent and reflects OAuth provider
 *    connection state alongside configured API, local CLI, and ACP routes.
 *    Clicking opens provider settings without disconnecting anything.
 *
 * Splitting the items keeps the agent-task display intact (no string-juggling
 * with provider state) and gives each entry a dedicated tooltip + command.
 */
export class StatusBarManager implements vscode.Disposable {
	private readonly agentItem: vscode.StatusBarItem;
	private readonly authItem: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly broker: CredentialBroker;
	private refreshSequence = 0;
	private disposed = false;

	constructor(agentManager: AgentManager, broker: CredentialBroker, private readonly secrets?: vscode.SecretStorage) {
		this.broker = broker;

		// --- Agent task indicator (existing behaviour preserved) ---
		this.agentItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			100
		);
		this.agentItem.command = 'sota.openChat';
		this.agentItem.tooltip = 'Son of Anton';
		this.updateAgent(agentManager.hasActiveAgents());
		this.agentItem.show();

		this.disposables.push(
			agentManager.onDidChangeTasks(() => {
				this.updateAgent(agentManager.hasActiveAgents());
			})
		);

		// --- Auth / provider indicator (new) ---
		this.authItem = vscode.window.createStatusBarItem(
			vscode.StatusBarAlignment.Left,
			99
		);
		this.authItem.show();

		// Render the disconnected baseline immediately so the item shows up on
		// activation; then kick off the async status fetch which will replace
		// the placeholder once it resolves.
		this.authItem.text = '$(account) ' + vscode.l10n.t('Checking Connections');
		this.authItem.command = 'sota.openProviderSettings';
		void this.refreshAuth();

		// CredentialBroker exposes onDidDisconnect; there is no onDidConnect
		// hook today, so the connect-side refresh is driven by the sign-in
		// commands (extension.ts) calling refreshAuth() after a successful
		// connect attempt.
		this.broker.onDidDisconnect(() => {
			void this.refreshAuth();
		});
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('sota')) { void this.refreshAuth(); }
		}));
		if (secrets) { this.disposables.push(secrets.onDidChange(() => { void this.refreshAuth(); })); }
	}

	/**
	 * Re-fetch broker status and re-render the auth status bar item.
	 * Exposed so command handlers can refresh after sign-in / sign-out.
	 */
	async refreshAuth(): Promise<void> {
		if (this.disposed) { return; }
		const sequence = ++this.refreshSequence;
		try {
			const config = vscode.workspace.getConfiguration('sota');
			const [providers, credentials] = await Promise.all([
				this.broker.status(),
				this.secrets ? detectCredentials(this.secrets, config, this.broker) : undefined,
			]);
			if (this.disposed || sequence !== this.refreshSequence) { return; }
			const sources: string[] = [];
			if (isClaudeCodeAvailable()) { sources.push(vscode.l10n.t('Claude Code installed; sign-in is checked when it runs.')); }
			if (isCodexAvailable()) { sources.push(vscode.l10n.t('Codex CLI installed; sign-in is checked when it runs.')); }
			const adapters = config.get<Array<{ id?: string; command?: string }>>('acp.agents', []);
			const configuredAdapters = Array.isArray(adapters) ? adapters.filter(adapter => typeof adapter?.id === 'string' && adapter.id.trim() && typeof adapter.command === 'string' && adapter.command.trim()).length : 0;
			if (configuredAdapters) { sources.push(vscode.l10n.t('{0} ACP adapters configured; availability is checked when they run.', configuredAdapters)); }
			if (credentials && hasAnyProvider({ ...credentials, codex: { hasCli: false } })) { sources.push(vscode.l10n.t('Provider credentials or local endpoints configured.')); }
			this.renderAuth(providers, sources);
		} catch {
			// status() should not throw, but guard so a transient failure does
			// not leave the status bar in a broken state.
			if (!this.disposed && sequence === this.refreshSequence) {
				this.authItem.text = '$(account) ' + vscode.l10n.t('Check Connections');
				this.authItem.tooltip = vscode.l10n.t('Connection status could not be read. Open provider settings to inspect your configuration.');
			}
		}
	}

	private updateAgent(hasActiveAgents: boolean): void {
		if (hasActiveAgents) {
			this.agentItem.text = '$(sync~spin) Son of Anton';
			this.agentItem.tooltip = 'Son of Anton — agents running';
		} else {
			this.agentItem.text = '$(hubot) Son of Anton';
			this.agentItem.tooltip = 'Son of Anton — idle';
		}
	}

	private renderAuth(providers: ReadonlyArray<ProviderStatus>, sources: string[]): void {
		const connected = providers.filter(p => p.connected);

		if (connected.length === 0) {
			this.authItem.text = '$(account) ' + (sources.length ? vscode.l10n.t('Connections Configured') : vscode.l10n.t('Connect a Provider'));
		} else if (connected.length === 1) {
			this.authItem.text = `$(account) ${connected[0].displayName}`;
		} else {
			this.authItem.text = `$(account) ${connected.length} providers`;
		}

		this.authItem.command = 'sota.openProviderSettings';
		this.authItem.tooltip = this.buildTooltip(providers, sources);
	}

	private buildTooltip(providers: ReadonlyArray<ProviderStatus>, sources: string[]): vscode.MarkdownString {
		const md = new vscode.MarkdownString(undefined, true);
		md.isTrusted = false;
		md.supportThemeIcons = true;

		if (providers.length === 0 && sources.length === 0) {
			md.appendText(vscode.l10n.t('No provider connection was detected. Click to open provider settings.'));
			return md;
		}

		md.appendMarkdown('**Son of Anton — Providers**\n\n');
		const lines: string[] = [];
		for (const p of providers) {
			if (p.connected) {
				lines.push(`- ${p.displayName}: connected${this.formatExpiry(p.expiresAt)}`);
			} else {
				lines.push(`- ${p.displayName}: not connected`);
			}
		}
		md.appendMarkdown(lines.join('\n'));
		for (const source of sources) { md.appendText('\n' + source); }
		md.appendText('\n\n' + vscode.l10n.t('Click to manage connections.'));
		// Bound unusually large provider lists without hiding normal setup details.
		const text = md.value;
		if (text.length > 1200) {
			const truncated = new vscode.MarkdownString(text.slice(0, 1197) + '...', true);
			truncated.supportThemeIcons = true;
			return truncated;
		}
		return md;
	}

	private formatExpiry(expiresAt?: number): string {
		if (typeof expiresAt !== 'number' || expiresAt <= 0) {
			return '';
		}
		const remainingMs = expiresAt - Date.now();
		if (remainingMs <= 0) {
			return ' (expired)';
		}
		const minutes = Math.round(remainingMs / 60000);
		if (minutes < 60) {
			return ` (expires in ${minutes}m)`;
		}
		const hours = Math.round(minutes / 60);
		if (hours < 48) {
			return ` (expires in ${hours}h)`;
		}
		const days = Math.round(hours / 24);
		return ` (expires in ${days}d)`;
	}

	dispose(): void {
		this.disposed = true;
		this.refreshSequence++;
		this.agentItem.dispose();
		this.authItem.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
