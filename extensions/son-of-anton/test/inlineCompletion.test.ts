/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import type * as VsCode from 'vscode';
import type { CompletionProvider } from '../src/inline/CompletionProvider';
const requireFromTest = createRequire(import.meta.url);
const vscode = requireFromTest('vscode');

interface Fixture {
	provider: CompletionProvider;
	document: VsCode.TextDocument;
	requests: Array<{ signal: AbortSignal; model: string }>;
	ready: Promise<void>;
	cancel(): void;
	release(): void;
	complete(): Promise<VsCode.InlineCompletionItem[] | undefined>;
}

async function withCompletions(debounceMs: number, run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const originalConfig = vscode.workspace.getConfiguration;
	const rangeDescriptor = Object.getOwnPropertyDescriptor(vscode, 'Range');
	const itemDescriptor = Object.getOwnPropertyDescriptor(vscode, 'InlineCompletionItem');
	vscode.Range = class Range {};
	vscode.InlineCompletionItem = class InlineCompletionItem { insertText: string; constructor(text: string) { this.insertText = text; } };
	vscode.workspace.getConfiguration = () => ({ get: (key: string, fallback: object) => ({ 'completions.debounceMs': debounceMs, 'completions.model': 'gpt-5-mini' })[key] ?? fallback });
	const listeners = new Set<() => void>();
	const token: VsCode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: listener => {
		const notify = () => listener(undefined); listeners.add(notify);
		return { dispose: () => { listeners.delete(notify); } };
	} };
	const document = { uri: { scheme: 'file' }, fileName: 'test.ts', languageId: 'typescript', version: 1, isClosed: false, lineCount: 1, lineAt: () => ({ text: 'if (ready) {', range: { end: { line: 0, character: 12 } } }), getText: () => 'if (ready) {' } as unknown as VsCode.TextDocument;
	let started!: () => void; let release!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const pending = new Promise<void>(resolve => { release = resolve; });
	const requests: Fixture['requests'] = [];
	const { CompletionProvider } = requireFromTest('../src/inline/CompletionProvider');
	const provider: CompletionProvider = new CompletionProvider({ request: async (request: typeof requests[number]) => { requests.push(request); started(); await pending; return '\n\treturn true;\n'; } });
	try {
		await run({ provider, document, requests, ready, release, cancel: () => { Object.assign(token, { isCancellationRequested: true }); for (const listener of listeners) listener(); }, complete: () => provider.provideInlineCompletionItems(document, { line: 0, character: 12 } as VsCode.Position, {} as VsCode.InlineCompletionContext, token) });
		assert.equal(listeners.size, 0, 'Every completion releases its cancellation listener');
	} finally {
		provider.dispose();
		vscode.workspace.getConfiguration = originalConfig;
		if (rangeDescriptor) Object.defineProperty(vscode, 'Range', rangeDescriptor); else delete vscode.Range;
		if (itemDescriptor) Object.defineProperty(vscode, 'InlineCompletionItem', itemDescriptor); else delete vscode.InlineCompletionItem;
	}
}

suite('Inline completion lifecycle', () => {
	test('preserves newlines and indentation and uses the chosen completion model', async () => {
		await withCompletions(0, async fixture => {
			const completion = fixture.complete(); await fixture.ready; fixture.release();
			assert.deepEqual((await completion)?.map(item => item.insertText), ['\n\treturn true;\n']);
			assert.equal(fixture.requests[0].model, 'gpt-5-mini');
		});
	});
	test('cancelling during debounce prevents the provider call', async () => {
		await withCompletions(2000, async fixture => { const completion = fixture.complete(); fixture.cancel(); assert.equal(await completion, undefined); assert.equal(fixture.requests.length, 0); });
	});
	test('cancelling a running provider aborts its request and ignores a late answer', async () => {
		await withCompletions(0, async fixture => { const completion = fixture.complete(); await fixture.ready; fixture.cancel(); assert.equal(fixture.requests[0].signal.aborted, true); fixture.release(); assert.equal(await completion, undefined); });
	});
	test('a document revision invalidates the suggestion even if the provider finishes', async () => {
		await withCompletions(0, async fixture => { const completion = fixture.complete(); await fixture.ready; Object.assign(fixture.document, { version: 2 }); fixture.release(); assert.equal(await completion, undefined); });
	});
	test('moving into an excluded document cancels work for the previous editor', async () => {
		await withCompletions(0, async fixture => { const completion = fixture.complete(); await fixture.ready; Object.assign(fixture.document, { languageId: 'plaintext' }); assert.equal(await fixture.complete(), undefined); assert.equal(fixture.requests[0].signal.aborted, true); fixture.release(); assert.equal(await completion, undefined); });
	});
	test('disposing the extension aborts a pending request', async () => {
		await withCompletions(0, async fixture => { const completion = fixture.complete(); await fixture.ready; fixture.provider.dispose(); assert.equal(fixture.requests[0].signal.aborted, true); fixture.release(); assert.equal(await completion, undefined); });
	});
});
