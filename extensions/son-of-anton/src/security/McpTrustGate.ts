/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { SupplyChainGuard } from './SupplyChainGuard';

/**
 * The user's decision when prompted to connect to an untrusted MCP server.
 */
export type McpTrustDecision = 'trust-always' | 'trust-session' | 'block';

/**
 * Extract a server name from a raw `sota.mcp.servers` entry, or `undefined` if
 * the entry is malformed. Kept pure and exported for unit testing.
 */
export function mcpServerName(entry: unknown): string | undefined {
	if (entry === null || typeof entry !== 'object') {
		return undefined;
	}
	const name = (entry as { name?: unknown }).name;
	return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined;
}

/**
 * Host seams the trust gate needs. Injected so the decision logic can be unit
 * tested without the live VS Code window / global state.
 */
export interface McpTrustGateDeps {
	/** Supply-chain guard whose `validateMcpConnection` records the audit log. */
	readonly guard: Pick<SupplyChainGuard, 'validateMcpConnection' | 'trustMcpServer'>;
	/** User/global persisted state (never workspace-scoped). */
	readonly globalState: vscode.Memento;
	/** Server names the user/admin has pre-trusted via user/global settings. */
	readonly getConfiguredTrusted: () => string[];
	/** True for the bundled internal code-graph server, which is never gated. */
	readonly isBundledServer: (name: string) => boolean;
	/** Ask the MCP client to re-read servers after an async approval. */
	readonly requestReconcile: () => void;
	/** Prompt the user for a decision. Defaults to a modal warning dialog. */
	readonly confirm?: (name: string) => Thenable<McpTrustDecision>;
}

/**
 * Gates connections to Model Context Protocol servers configured in
 * `sota.mcp.servers`.
 *
 * MCP servers spawn arbitrary local processes and expose tools that can read
 * files and run commands, so an untrusted server is a supply-chain risk. This
 * gate sits on the extension's MCP bring-up path (the `readServersSetting`
 * closure feeding `McpClient`) and filters out any server the user has not
 * trusted **before** the client ever spawns it. Untrusted servers trigger an
 * explicit confirmation prompt; the client only sees them once approved.
 *
 * Trust is sourced from **user/global** configuration — the `sota.mcp.trustedServers`
 * setting (application scope) plus decisions persisted in global state — never
 * from the workspace, so a cloned repository cannot silently pre-trust a server.
 */
export class McpTrustGate implements vscode.Disposable {
	private static readonly STORAGE_KEY = 'sota.mcp.approvedServers';

	private readonly deps: McpTrustGateDeps;
	/** Names cleared to connect (config + persisted + this-session approvals). */
	private readonly approved = new Set<string>();
	/** Names the user blocked this session — excluded without re-prompting. */
	private readonly denied = new Set<string>();
	/** Names already run through `validateMcpConnection` / prompt (dedupe). */
	private readonly evaluated = new Set<string>();

	constructor(deps: McpTrustGateDeps) {
		this.deps = deps;
		const persisted = deps.globalState.get<string[]>(McpTrustGate.STORAGE_KEY, []);
		for (const name of [...deps.getConfiguredTrusted(), ...(Array.isArray(persisted) ? persisted : [])]) {
			if (typeof name === 'string' && name.trim().length > 0) {
				this.approved.add(name.trim());
			}
		}
	}

	/**
	 * Filter a raw `sota.mcp.servers` array down to the entries that are cleared
	 * to connect. Untrusted, not-yet-decided entries are excluded and trigger an
	 * asynchronous confirmation prompt; entries without a usable name are passed
	 * through so the MCP client's own validation still reports them.
	 */
	filterTrusted(rawList: readonly unknown[]): unknown[] {
		// Read the user/global trusted-server setting live so edits take effect
		// on the next reconcile without a window reload. (Removing a name only
		// revokes trust after reload — matching the trusted-folders behaviour.)
		const configured = new Set(this.deps.getConfiguredTrusted());
		const out: unknown[] = [];
		for (const entry of rawList) {
			const name = mcpServerName(entry);
			if (name === undefined) {
				// Malformed entry — let McpClient validate / skip and log it.
				out.push(entry);
				continue;
			}
			if (this.deps.isBundledServer(name) || this.approved.has(name) || configured.has(name)) {
				out.push(entry);
				continue;
			}
			if (this.denied.has(name)) {
				continue;
			}
			if (!this.evaluated.has(name)) {
				this.evaluated.add(name);
				// Wire the supply-chain guard's trust check into the bring-up
				// path: it records an audit-log entry for the attempt and honours
				// any explicitly loaded trust list. `false` means "not trusted" —
				// block now and ask the user.
				if (this.deps.guard.validateMcpConnection(name)) {
					this.approved.add(name);
					out.push(entry);
					continue;
				}
				void this.promptForServer(name);
			}
			// Not trusted (prompt in flight or awaiting a fresh decision): exclude.
		}
		return out;
	}

	dispose(): void {
		this.approved.clear();
		this.denied.clear();
		this.evaluated.clear();
	}

	private async promptForServer(name: string): Promise<void> {
		const confirm = this.deps.confirm ?? McpTrustGate.defaultConfirm;
		let decision: McpTrustDecision;
		try {
			decision = await confirm(name);
		} catch {
			decision = 'block';
		}

		if (decision === 'trust-always') {
			this.approved.add(name);
			this.deps.guard.trustMcpServer(name, 'user approved (trust always)');
			await this.persistApproval(name);
			this.deps.requestReconcile();
		} else if (decision === 'trust-session') {
			this.approved.add(name);
			this.deps.requestReconcile();
		} else {
			this.denied.add(name);
		}
	}

	private async persistApproval(name: string): Promise<void> {
		const current = this.deps.globalState.get<string[]>(McpTrustGate.STORAGE_KEY, []);
		const next = Array.isArray(current) ? [...current] : [];
		if (!next.includes(name)) {
			next.push(name);
			await this.deps.globalState.update(McpTrustGate.STORAGE_KEY, next);
		}
	}

	private static async defaultConfirm(name: string): Promise<McpTrustDecision> {
		const choice = await vscode.window.showWarningMessage(
			`Son of Anton: connect to MCP server "${name}"?`,
			{
				modal: true,
				detail: `"${name}" is not in your trusted-server list. MCP servers spawn a local process and can expose tools that read your files and run commands. Only trust servers you recognise.`,
			},
			'Trust This Session',
			'Trust Always',
		);
		if (choice === 'Trust Always') {
			return 'trust-always';
		}
		if (choice === 'Trust This Session') {
			return 'trust-session';
		}
		return 'block';
	}
}
