/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import type * as vscode from 'vscode';
import { McpTrustGate, mcpServerName, type McpTrustDecision } from '../src/security/McpTrustGate';

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
	bundled?: string[];
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
		isBundledServer: (name) => (opts.bundled ?? []).includes(name),
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

	test('bundled servers pass through without a prompt', async () => {
		const h = makeGate({ bundled: ['code-graph'] });
		const result = h.gate.filterTrusted([server('code-graph')]);
		await flush();
		assert.deepStrictEqual(
			{ passed: names(result), reconciles: h.reconciles },
			{ passed: ['code-graph'], reconciles: 0 },
		);
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
				persisted: h.memento.get<string[]>('sota.mcp.approvedServers', []),
				reconciles: h.reconciles,
			},
			{ trusted: ['sketchy'], persisted: ['sketchy'], reconciles: 1 },
		);

		// Second pass (the reconcile): now cleared to connect.
		const second = h.gate.filterTrusted([server('sketchy')]);
		assert.deepStrictEqual(names(second), ['sketchy']);
	});

	test('"block" keeps the server excluded and does not re-prompt on reconcile', async () => {
		let prompts = 0;
		const memento = new FakeMemento();
		const gate = new McpTrustGate({
			guard: { validateMcpConnection: () => false, trustMcpServer: () => { /* no-op */ } },
			globalState: memento as unknown as vscode.Memento,
			getConfiguredTrusted: () => [],
			isBundledServer: () => false,
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
