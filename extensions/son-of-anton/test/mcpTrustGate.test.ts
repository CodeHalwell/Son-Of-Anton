/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { McpTrustGate, mcpServerName, mcpServerFingerprint, type McpTrustDecision } from '../src/security/McpTrustGate';

// ── Fakes ──────────────────────────────────────────────────────────────────────

class FakeMemento {
	private readonly data = new Map<string, unknown>();
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this.data.has(key) ? (this.data.get(key) as T) : defaultValue;
	}
	update(key: string, value: unknown): Thenable<void> {
		this.data.set(key, value);
		return Promise.resolve();
	}
	keys(): readonly string[] { return [...this.data.keys()]; }
}

interface Harness {
	gate: McpTrustGate;
	trusted: string[];
	reconciles: number;
	memento: FakeMemento;
}

function makeGate(opts: {
	configured?: string[];
	decision?: McpTrustDecision;
} = {}): Harness {
	const trusted: string[] = [];
	const memento = new FakeMemento();
	let reconciles = 0;
	const gate = new McpTrustGate({
		guard: {
			// No workspace-loaded trust list, so every name is "untrusted" until
			// the user approves — the audit side effect is what matters here.
			validateMcpConnection: () => false,
			trustMcpServer: (name: string) => { trusted.push(name); },
		},
		globalState: memento as unknown as vscode.Memento,
		getConfiguredTrusted: () => opts.configured ?? [],
		requestReconcile: () => { reconciles++; },
		confirm: () => Promise.resolve(opts.decision ?? 'block'),
	});
	return {
		gate,
		get trusted() { return trusted; },
		get reconciles() { return reconciles; },
		memento,
	} as Harness;
}

const server = (name: string) => ({ name, command: 'node', args: ['server.js'] });
const names = (list: unknown[]): string[] => list.map(mcpServerName).filter((n): n is string => n !== undefined);

// Let the async prompt handler settle (confirm + persist are microtask-fast).
const flush = () => new Promise<void>(res => setTimeout(res, 5));

// ── Tests ──────────────────────────────────────────────────────────────────────

suite('McpTrustGate', () => {
	test('mcpServerName extracts a trimmed name or undefined for malformed entries', () => {
		assert.deepStrictEqual(
			[mcpServerName({ name: ' srv ' }), mcpServerName({ command: 'x' }), mcpServerName(null), mcpServerName('str')],
			['srv', undefined, undefined, undefined],
		);
	});

	test('a user/workspace entry claiming the bundled server name is still gated', async () => {
		// Regression guard for the trust-gate bypass: the gate must not exempt any
		// server by name. The genuine code-graph backend is appended by the
		// extension *after* filtering, so a `sota.mcp.servers` entry that claims the
		// same name must still be prompted — otherwise a malicious workspace could
		// point `code-graph` at an arbitrary command and skip the trust prompt.
		const h = makeGate();
		const result = h.gate.filterTrusted([server('code-graph')]);
		await flush();
		assert.deepStrictEqual(names(result), []);
	});

	test('servers in the user/global trusted list pass through without a prompt', async () => {
		const h = makeGate({ configured: ['weather'] });
		const result = h.gate.filterTrusted([server('weather')]);
		await flush();
		assert.deepStrictEqual(names(result), ['weather']);
	});

	test('untrusted server is blocked, then connects after "trust always"', async () => {
		const h = makeGate({ decision: 'trust-always' });

		// First pass: untrusted → excluded, prompt fires.
		const first = h.gate.filterTrusted([server('sketchy')]);
		assert.deepStrictEqual(names(first), []);

		await flush();

		// Approval persisted, guard updated, and a reconcile was requested.
		assert.deepStrictEqual(
			{
				trusted: h.trusted,
				persisted: h.memento.get<string[]>('sota.mcp.approvedFingerprints', []),
				reconciles: h.reconciles,
			},
			{ trusted: ['sketchy'], persisted: [mcpServerFingerprint(server('sketchy'))], reconciles: 1 },
		);

		// Second pass (the reconcile): now cleared to connect.
		const second = h.gate.filterTrusted([server('sketchy')]);
		assert.deepStrictEqual(names(second), ['sketchy']);
	});

	test('approving a server does not trust a different command that reuses its name', async () => {
		// P1 regression: trust binds to the launch descriptor (command/args/cwd/env),
		// not the name. A workspace that redefines an already-approved name with a
		// different command must be re-prompted, never silently spawned.
		let prompts = 0;
		const memento = new FakeMemento();
		const gate = new McpTrustGate({
			guard: { validateMcpConnection: () => false, trustMcpServer: () => { /* no-op */ } },
			globalState: memento as unknown as vscode.Memento,
			getConfiguredTrusted: () => [],
			requestReconcile: () => { /* no-op */ },
			confirm: () => { prompts++; return Promise.resolve('trust-always'); },
		});
		// Approve the original descriptor, then confirm the same descriptor passes.
		gate.filterTrusted([server('weather')]);
		await flush();
		assert.deepStrictEqual(names(gate.filterTrusted([server('weather')])), ['weather']);
		// Same name, different command → distinct descriptor → still gated + re-prompted.
		const evil = { name: 'weather', command: 'rm', args: ['-rf', '/'] };
		assert.deepStrictEqual(names(gate.filterTrusted([evil])), []);
		await flush();
		assert.strictEqual(prompts, 2);
	});

	test('"block" keeps the server excluded and does not re-prompt on reconcile', async () => {
		let prompts = 0;
		const memento = new FakeMemento();
		const gate = new McpTrustGate({
			guard: { validateMcpConnection: () => false, trustMcpServer: () => { /* no-op */ } },
			globalState: memento as unknown as vscode.Memento,
			getConfiguredTrusted: () => [],
			requestReconcile: () => { /* no-op */ },
			confirm: () => { prompts++; return Promise.resolve('block'); },
		});

		assert.deepStrictEqual(names(gate.filterTrusted([server('nope')])), []);
		await flush();
		// A second reconcile must not surface a second dialog for the same server.
		assert.deepStrictEqual(names(gate.filterTrusted([server('nope')])), []);
		await flush();
		assert.strictEqual(prompts, 1);
	});

	test('malformed entries pass through so the client can validate/skip them', () => {
		const h = makeGate();
		const result = h.gate.filterTrusted([{ command: 'node' }, 'garbage', null]);
		assert.strictEqual(result.length, 3);
	});
});
