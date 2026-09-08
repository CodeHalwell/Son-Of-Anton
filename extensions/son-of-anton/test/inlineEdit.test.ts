/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import type * as VsCode from 'vscode';
import type { LlmClient } from 'son-of-anton-core/llm/LlmClient';

// Exercise the actual command lifecycle with a controlled editor and provider.
const requireFromTest = createRequire(import.meta.url);
const vscode = requireFromTest('vscode');
const original = 'function example() {\n\treturn 1;\n}\n';
const replacement = '\treturn 2;';

async function withEditor(options: {
	choice?: string;
	response?: string;
	changeDuring?: 'prompt' | 'generation' | 'review';
	cancel?: boolean;
	applyResult?: boolean;
	closeReview?: boolean;
}, run: (result: { text: string; previews: string[]; events: string[]; model: string; disposed: number }) => void): Promise<void> {
	const restore: Array<() => void> = [];
	function patch(target: Record<string, object>, key: string, value: object): void {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		restore.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; });
		Object.defineProperty(target, key, { value, configurable: true, writable: true });
	}
	const result = { text: original, previews: [] as string[], events: [] as string[], model: '', disposed: 0 };
	const selection = { isEmpty: false, start: { line: 1, character: 0 }, end: { line: 1, character: 10 } };
	const document = {
		uri: { scheme: 'file' }, fileName: '/workspace/example.ts', languageId: 'typescript', version: 1, isClosed: false, lineCount: 4, eol: 1,
		getText: (range?: object) => range ? '\treturn 1;' : result.text,
		offsetAt: (position: { line: number; character: number }) => result.text.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
		lineAt: (line: number) => ({ range: { end: { line, character: result.text.split('\n')[line].length } } }),
	};
	const change = () => { document.version++; result.text = '// your edit\n' + original; };
	let provider: VsCode.TextDocumentContentProvider;
	let cancel: () => void = () => {};
	let tabs: object[] = [];
	let controls = 0;
	let closeReview: (event: { closed: object[] }) => void = () => {};
	class TabInputTextDiff { original: VsCode.Uri; modified: VsCode.Uri; constructor(original: VsCode.Uri, modified: VsCode.Uri) { this.original = original; this.modified = modified; } }
	patch(vscode, 'TabInputTextDiff', TabInputTextDiff);
	patch(vscode, 'EndOfLine', { LF: 1, CRLF: 2 });
	patch(vscode, 'Position', class { line: number; character: number; constructor(line: number, character: number) { this.line = line; this.character = character; } });
	patch(vscode, 'l10n', { t: (message: string, ...args: string[]) => message.replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]) });
	patch(vscode.Uri, 'from', (value: { authority: string; path: string }) => ({ toString: () => 'sota-inline-preview://' + value.authority + value.path }));
	patch(vscode.workspace, 'registerTextDocumentContentProvider', (_scheme: string, value: VsCode.TextDocumentContentProvider) => { provider = value; return { dispose() { result.disposed++; } }; });
	patch(vscode.workspace, 'getConfiguration', () => ({ get: () => 'gpt-5-mini' }));
	patch(vscode.window, 'activeTextEditor', { document, selection, viewColumn: 1, edit: async (build: (builder: object) => void) => {
		result.events.push('apply');
		build({ replace: (_range: object, value: string) => { if (options.applyResult !== false) result.text = original.replace('\treturn 1;', value); } });
		return options.applyResult !== false;
	} });
	patch(vscode.window, 'showInputBox', async () => { if (options.changeDuring === 'prompt') change(); return 'Return two'; });
	patch(vscode.window, 'withProgress', async (_options: object, task: Function) => task({}, { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => { cancel = listener; return { dispose: () => result.events.push('cancel-listener-disposed') }; } }));
	patch(vscode.window, 'showInformationMessage', async (_message: string, ...choices: string[]) => {
		if (choices.includes('Apply Edit')) {
			result.events.push('review');
			if (options.closeReview) { const closed = tabs; tabs = []; closeReview({ closed }); return new Promise<string>(() => {}); }
			if (options.changeDuring === 'review') change();
			return options.choice ?? 'Apply Edit';
		}
		result.events.push('information');
		return undefined;
	});
	patch(vscode.window, 'showWarningMessage', async () => { result.events.push('warning'); });
	patch(vscode.window, 'showErrorMessage', async (message: string) => { throw new Error(message); });
	patch(vscode.window, 'createStatusBarItem', () => { controls++; return { show() {}, dispose() { controls--; } }; });
	patch(vscode.window, 'showTextDocument', async () => { result.events.push('reveal'); });
	patch(vscode.window, 'tabGroups', { get all() { return [{ tabs }]; }, onDidChangeTabs: (listener: typeof closeReview) => { closeReview = listener; return { dispose() {} }; }, close: async () => { result.events.push('close-preview'); tabs = []; } });
	patch(vscode.commands, 'executeCommand', async (command: string, before: VsCode.Uri, after: VsCode.Uri) => {
		assert.equal(command, 'vscode.diff');
		result.events.push('diff');
		result.previews = [await provider.provideTextDocumentContent(before, {} as VsCode.CancellationToken), await provider.provideTextDocumentContent(after, {} as VsCode.CancellationToken)] as string[];
		tabs = [{ input: new TabInputTextDiff(before, after) }];
	});
	const llm = { request: async (request: { model: string }) => {
		result.events.push('generate'); result.model = request.model;
		if (options.changeDuring === 'generation') change();
		if (options.cancel) cancel();
		return options.response ?? replacement;
	} } as unknown as LlmClient;
	const { InlineEditProvider } = requireFromTest('../src/inline/InlineEdit');
	const command = new InlineEditProvider(llm);
	try {
		await command.provideInlineEdit();
		command.dispose();
		assert.equal(controls, 0, 'Review actions are removed after acceptance, dismissal, or cancellation');
		run(result);
	} finally {
		for (const undo of restore.reverse()) undo();
	}
}

suite('Inline edit review', () => {
	test('closing the diff discards the edit even when the notification is unanswered', async () => {
		await withEditor({ closeReview: true }, result => { assert.equal(result.text, original); assert.ok(!result.events.includes('apply')); });
	});
	test('shows full-file immutable diff before applying one edit, preserves indentation, and uses the configured model', async () => {
		await withEditor({}, result => assert.deepEqual(result, {
			text: original.replace('\treturn 1;', replacement), previews: [original, original.replace('\treturn 1;', replacement)],
			events: ['generate', 'cancel-listener-disposed', 'diff', 'review', 'apply', 'reveal', 'close-preview'], model: 'gpt-5-mini', disposed: 1,
		}));
	});
	for (const changeDuring of ['prompt', 'generation', 'review'] as const) {
		test(`preserves user changes made during ${changeDuring}`, async () => {
			await withEditor({ changeDuring }, result => { assert.equal(result.text, '// your edit\n' + original); assert.ok(!result.events.includes('apply')); assert.ok(result.events.includes('warning')); });
		});
	}
	test('discard closes only the review and leaves the source intact', async () => {
		await withEditor({ choice: 'Discard Edit' }, result => { assert.equal(result.text, original); assert.deepEqual(result.events.slice(-3), ['diff', 'review', 'close-preview']); });
	});
	test('late provider completion after cancellation never opens a review', async () => {
		await withEditor({ cancel: true }, result => assert.deepEqual({ text: result.text, previews: result.previews, events: result.events }, { text: original, previews: [], events: ['generate', 'cancel-listener-disposed'] }));
	});
	test('fenced code preserves its indentation', async () => {
		await withEditor({ response: '```ts\n\treturn 2;\n```' }, result => assert.equal(result.text, original.replace('\treturn 1;', replacement)));
	});
	test('failed versioned application does not report success', async () => {
		await withEditor({ applyResult: false }, result => { assert.equal(result.text, original); assert.ok(result.events.includes('warning')); assert.ok(!result.events.includes('reveal')); });
	});
});
