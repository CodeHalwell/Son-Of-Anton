/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { PassThrough } from 'node:stream';
import * as vscode from 'vscode';
import { TerminalCaptureBuffer } from '../src/chat/TerminalCaptureBuffer';
import { WorkspaceContextProvider } from '../src/chat/WorkspaceContextProvider';
import { ChatSession } from '../src/chat/ChatPanel';

/** Controllable host events with real listener disposal. */
function eventSource<T>() {
	const listeners = new Set<(value: T) => void>();
	return { event: (listener: (value: T) => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }, fire: (value: T) => { for (const listener of listeners) { listener(value); } } };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

suite('Terminal context capture', () => {
	const start = eventSource<vscode.TerminalShellExecutionStartEvent>();
	const end = eventSource<vscode.TerminalShellExecutionEndEvent>();
	const close = eventSource<vscode.Terminal>();
	const configuration = eventSource<vscode.ConfigurationChangeEvent>();
	let buffer: TerminalCaptureBuffer;
	let enabled: boolean;
	let lineCap: number;
	let restore: () => void;
	let streams: PassThrough[];
	const terminal = { shellIntegration: {}, name: 'Build' } as vscode.Terminal;

	setup(() => {
		enabled = true; lineCap = 100; streams = [];
		const windowKeys = ['onDidStartTerminalShellExecution', 'onDidEndTerminalShellExecution', 'onDidCloseTerminal', 'activeTerminal'] as const;
		const originals = windowKeys.map(key => [key, Object.getOwnPropertyDescriptor(vscode.window, key)] as const);
		const configOriginal = vscode.workspace.getConfiguration;
		const changedOriginal = Object.getOwnPropertyDescriptor(vscode.workspace, 'onDidChangeConfiguration');
		Object.assign(vscode.window, { onDidStartTerminalShellExecution: start.event, onDidEndTerminalShellExecution: end.event, onDidCloseTerminal: close.event, activeTerminal: terminal });
		Object.assign(vscode.workspace, {
			onDidChangeConfiguration: configuration.event,
			getConfiguration: () => ({ get: (key: string, fallback: boolean | number) => key === 'shellIntegration' ? enabled : key === 'outputLineCap' ? lineCap : fallback }),
		});
		restore = () => {
			for (const [key, descriptor] of originals) {
				if (descriptor) { Object.defineProperty(vscode.window, key, descriptor); } else { Reflect.deleteProperty(vscode.window, key); }
			}
			Object.assign(vscode.workspace, { getConfiguration: configOriginal });
			if (changedOriginal) { Object.defineProperty(vscode.workspace, 'onDidChangeConfiguration', changedOriginal); } else { Reflect.deleteProperty(vscode.workspace, 'onDidChangeConfiguration'); }
		};
		buffer = new TerminalCaptureBuffer();
	});
	teardown(() => { buffer.dispose(); for (const stream of streams) { stream.destroy(); } restore(); });

	function command(commandLine = 'npm test', target = terminal) {
		const stream = new PassThrough({ encoding: 'utf8' }); streams.push(stream);
		const execution: vscode.TerminalShellExecution = { commandLine: { value: commandLine, confidence: 2, isTrusted: true }, cwd: undefined, read: () => stream };
		start.fire({ terminal: target, execution, shellIntegration: target.shellIntegration! });
		return { stream, execution, end: (exitCode?: number) => end.fire({ terminal: target, execution, exitCode, shellIntegration: target.shellIntegration! }) };
	}
	function context() {
		return Object.assign(Object.create(WorkspaceContextProvider.prototype), { terminalCapture: buffer }) as WorkspaceContextProvider;
	}

	test('retains the failure at the tail of long output and applies line limit changes immediately', async () => {
		const run = command();
		for (let index = 0; index < 650; index++) { run.stream.write(`build step ${index} ${'x'.repeat(50)}\n`); }
		run.stream.write('FINAL FAILURE\n'); await flush();
		lineCap = 20;
		const small = buffer.lastOutputFor(terminal)!;
		lineCap = 500;
		const large = buffer.lastOutputFor(terminal)!;
		assert.ok(small.output.endsWith('FINAL FAILURE\n') && !small.output.includes('build step 0 '));
		assert.equal(small.output.trimEnd().split('\n').length, 20);
		assert.ok(large.output.length > small.output.length && Buffer.byteLength(large.output) <= 16 * 1024);
		assert.equal(small.truncated, true);
	});

	test('preserves Unicode boundaries within the byte budget and sanitizes split terminal controls', async () => {
		const run = command();
		run.stream.write('😀'.repeat(10000)); await flush();
		const unicode = buffer.lastOutputFor(terminal)!.output;
		assert.equal(Buffer.byteLength(unicode), 16 * 1024);
		assert.ok(!unicode.includes('\ufffd'));
		const next = command();
		for (const chunk of ['\x1b]633;private', ' marker\x1b', '\\Visible\x1b[3', '1m error\x1b[0m\r', '\nnext\x07\x00']) { next.stream.write(chunk); await flush(); }
		assert.equal(buffer.lastOutputFor(terminal)!.output, 'Visible error\nnext');
	});

	test('includes final data delivered after the end event and updates the final command line', async () => {
		const run = command('npm');
		run.stream.write('starting\n'); await flush();
		Object.assign(run.execution, { commandLine: { value: 'npm test' } }); run.end(2);
		run.stream.end('test failed\n'); await flush();
		assert.deepEqual(buffer.lastOutputFor(terminal), { commandLine: 'npm test', output: 'starting\ntest failed\n', running: false, exitCode: 2, truncated: false, readFailed: false });
	});

	test('stale execution events cannot complete or overwrite a newer command', async () => {
		const old = command('old'); old.stream.write('old text'); await flush();
		const current = command('new'); current.stream.write('current'); await flush();
		old.end(1); old.stream.end('late old output'); await flush();
		assert.deepEqual(buffer.lastOutputFor(terminal), { commandLine: 'new', output: 'current', running: true, exitCode: undefined, truncated: false, readFailed: false });
	});

	test('disable clears captures and reenabling only captures newly started commands', async () => {
		const run = command(); run.stream.write('before'); await flush();
		enabled = false; configuration.fire({ affectsConfiguration: () => true });
		assert.equal(buffer.lastOutputFor(terminal), undefined);
		enabled = true; run.stream.end('after'); await flush();
		assert.equal(buffer.lastOutputFor(terminal), undefined);
		const current = command(); current.stream.write('new'); await flush();
		assert.equal(buffer.lastOutputFor(terminal)?.output, 'new');
	});

	test('closed terminals and disposed buffers release captures and ignore later events', async () => {
		const run = command(); run.stream.write('gone'); await flush();
		close.fire(terminal); run.end(0);
		assert.equal(buffer.lastOutputFor(terminal), undefined);
		buffer.dispose(); command();
		assert.equal(buffer.lastOutputFor(terminal), undefined);
	});

	test('records interrupted reads without discarding useful partial output', async () => {
		const run = command(); run.stream.write('useful diagnostic'); await flush();
		run.stream.destroy(new Error('terminal unavailable')); await flush();
		assert.match(await context().resolveTerminalMention(), /interrupted[\s\S]*useful diagnostic/);
	});

	test('both attachment entry points include the same command, current status, and output', async () => {
		const run = command(); run.stream.write('an error'); await flush();
		const session = Object.assign(Object.create(ChatSession.prototype), { workspaceContext: context() }) as { buildUserPrompt(text: string, attachments?: string[], mentions?: string[], kinded?: Array<{ kind: string }>): Promise<string> };
		const attachment = await session.buildUserPrompt('Explain this', ['terminal-output']);
		const mention = await session.buildUserPrompt('Explain this', undefined, undefined, [{ kind: 'terminal' }]);
		assert.equal(attachment, mention);
		assert.match(attachment, /Running[\s\S]*npm test[\s\S]*an error/);
		run.end(1);
		assert.match(await context().resolveTerminalMention(), /Exited with code 1/);
	});

	test('empty commands do not invent output, and output cannot close its Markdown fence', async () => {
		const empty = command(); empty.end(0);
		assert.match(await context().resolveTerminalMention(), /Command produced no output/);
		const run = command('echo ```'); run.stream.write('```\n# output'); await flush();
		assert.match(await context().resolveTerminalMention(), /````text\n\$ echo ```[\s\S]*# output\n````/);
	});

	test('unavailable capture explains the specific recovery action', async () => {
		const provider = context();
		assert.match(await provider.resolveTerminalMention(), /No command captured yet/);
		Object.assign(vscode.window, { activeTerminal: { name: 'No integration' } });
		assert.match(await provider.resolveTerminalMention(), /Shell integration is unavailable/);
		Object.assign(vscode.window, { activeTerminal: undefined });
		assert.match(await provider.resolveTerminalMention(), /No active terminal/);
		enabled = false;
		assert.match(await provider.resolveTerminalMention(), /Terminal capture is off/);
	});
});
