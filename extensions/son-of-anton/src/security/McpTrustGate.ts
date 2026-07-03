/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
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
 * Compute a stable trust fingerprint for a raw `sota.mcp.servers` entry, or
 * `undefined` when the entry has no usable name. The fingerprint covers the full
 * launch descriptor — name, command, args, cwd and env — because trust is bound
 * to *what will actually be spawned*, not just the server's name. This is what
 * stops a workspace-supplied entry from reusing a previously-approved name with a
 * different command to skip the prompt. Kept pure and exported for unit testing.
 */
export function mcpServerFingerprint(entry: unknown): string | undefined {
	const name = mcpServerName(entry);
	if (name === undefined) {
		return undefined;
	}
	const e = entry as { command?: unknown; args?: unknown; cwd?: unknown; env?: unknown };
	const command = typeof e.command === 'string' ? e.command : '';
	const args = Array.isArray(e.args) ? e.args.map(a => String(a)) : [];
	const cwd = typeof e.cwd === 'string' ? e.cwd : '';
	const env = e.env !== null && typeof e.env === 'object' ? (e.env as Record<string, unknown>) : {};
	// Sort env keys so equivalent descriptors hash identically regardless of key
	// order. NUL / SOH separators keep field boundaries unambiguous.
	const envStr = Object.keys(env).sort().map(k => `${k}=${String(env[k])}`).join('\u0000');
	// Return a DIGEST of the descriptor, not the descriptor itself: persisting
	// an approval writes this value to global state, and the raw descriptor can
	// hold `env` secrets (e.g. GITHUB_TOKEN). Hashing keeps trust
	// descriptor-bound while never storing those secrets in plaintext.
	const descriptor = [name, command, args.join('\u0000'), cwd, envStr].join('\u0001');
	return createHash('sha256').update(descriptor).digest('hex');
}

/**
 * Host seams the trust gate needs. Injected so the decision logic can be unit
 * tested without the live VS Code window / global state.
 */
export interface McpTrustGateDeps {
	/**
	 * Supply-chain guard, used purely as an audit sink. The gate deliberately
	 * depends only on `recordMcpConnectionAttempt` — never a trust-returning
	 * method — so guard state can never gate an approval. (An interactive
	 * "trust always" that seeded name-based guard trust could otherwise bless a
	 * different command that later reuses the same name.)
	 */
	readonly guard: Pick<SupplyChainGuard, 'recordMcpConnectionAttempt'>;
	/** User/global persisted state (never workspace-scoped). */
	readonly globalState: vscode.Memento;
	/** Server names the user/admin has pre-trusted via user/global settings. */
	readonly getConfiguredTrusted: () => string[];
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
 * Trust is sourced from **user/global** configuration — never the workspace — so
 * a cloned repository cannot silently pre-trust a server:
 *
 *   - Prompt / persisted approvals are keyed by the full launch **descriptor**
 *     (a {@link mcpServerFingerprint}), not the server name. Because
 *     `sota.mcp.servers` can be supplied by a workspace, approving a server once
 *     must not bless a different command that later reuses the same name — the
 *     fingerprint changes, so a mutated descriptor is re-prompted.
 *   - The `sota.mcp.trustedServers` setting (application scope) is an explicit,
 *     name-based pre-trust list. It is honoured by name because the user typed
 *     the name into their own global settings; only pre-trust names whose server
 *     definitions you control.
 */
export class McpTrustGate implements vscode.Disposable {
	private static readonly STORAGE_KEY = 'sota.mcp.approvedFingerprints';

	private readonly deps: McpTrustGateDeps;
	/** Descriptor fingerprints cleared to connect (persisted + this-session). */
	private readonly approvedFingerprints = new Set<string>();
	/** Fingerprints the user blocked this session — excluded without re-prompting. */
	private readonly deniedFingerprints = new Set<string>();
	/** Fingerprints already audited / prompted this session (dedupe). */
	private readonly evaluatedFingerprints = new Set<string>();

	constructor(deps: McpTrustGateDeps) {
		this.deps = deps;
		// Persisted approvals are descriptor fingerprints (see STORAGE_KEY). The
		// name-based `sota.mcp.trustedServers` list is read live in filterTrusted.
		const persisted = deps.globalState.get<string[]>(McpTrustGate.STORAGE_KEY, []);
		for (const fingerprint of Array.isArray(persisted) ? persisted : []) {
			if (typeof fingerprint === 'string' && fingerprint.length > 0) {
				this.approvedFingerprints.add(fingerprint);
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
			// name is defined, so the fingerprint is too.
			const fingerprint = mcpServerFingerprint(entry) as string;
			// A previously-approved DESCRIPTOR (fingerprint) matches only when the
			// command/args/cwd/env are unchanged, so a workspace cannot reuse an
			// approved name with a different command to bypass the prompt. A
			// configured (user/global) trusted NAME is an explicit pre-trust. The
			// bundled code-graph backend is appended by the extension *after* this
			// filter runs, so it never needs a name exemption here.
			if (this.approvedFingerprints.has(fingerprint) || configured.has(name)) {
				out.push(entry);
				continue;
			}
			if (this.deniedFingerprints.has(fingerprint)) {
				continue;
			}
			if (!this.evaluatedFingerprints.has(fingerprint)) {
				this.evaluatedFingerprints.add(fingerprint);
				// Record the attempt for auditing, then ask the user. The guard is
				// only an audit sink here — it is NEVER consulted for approval, so
				// no amount of guard trust state (e.g. a prior interactive "trust
				// always" that reused this name) can auto-clear a fresh descriptor.
				this.deps.guard.recordMcpConnectionAttempt(name, false);
				void this.promptForServer(name, fingerprint);
			}
			// Not trusted (prompt in flight or awaiting a fresh decision): exclude.
		}
		return out;
	}

	dispose(): void {
		this.approvedFingerprints.clear();
		this.deniedFingerprints.clear();
		this.evaluatedFingerprints.clear();
	}

	private async promptForServer(name: string, fingerprint: string): Promise<void> {
		const confirm = this.deps.confirm ?? McpTrustGate.defaultConfirm;
		let decision: McpTrustDecision;
		try {
			decision = await confirm(name);
		} catch {
			decision = 'block';
		}

		if (decision === 'trust-always') {
			// Persist the DESCRIPTOR fingerprint only. Deliberately not
			// `guard.trustMcpServer(name, …)`: seeding name-based guard trust
			// would let a later same-name/different-command entry clear itself
			// without a prompt. Descriptor-bound approval is the whole point.
			this.approvedFingerprints.add(fingerprint);
			await this.persistApproval(fingerprint);
			this.deps.requestReconcile();
		} else if (decision === 'trust-session') {
			this.approvedFingerprints.add(fingerprint);
			this.deps.requestReconcile();
		} else {
			this.deniedFingerprints.add(fingerprint);
		}
	}

	private async persistApproval(fingerprint: string): Promise<void> {
		const current = this.deps.globalState.get<string[]>(McpTrustGate.STORAGE_KEY, []);
		const next = Array.isArray(current) ? [...current] : [];
		if (!next.includes(fingerprint)) {
			next.push(fingerprint);
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
