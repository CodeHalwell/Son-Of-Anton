/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_LINES = 500;

/** A bounded snapshot of the latest command, including output still arriving. */
export interface CapturedTerminalOutput {
	readonly commandLine: string;
	readonly output: string;
	readonly running: boolean;
	readonly exitCode?: number;
	readonly truncated: boolean;
	readonly readFailed: boolean;
}

interface CaptureState {
	readonly execution: vscode.TerminalShellExecution;
	readonly cleaner: TerminalTextFilter;
	commandLine: string;
	output: string;
	running: boolean;
	exitCode?: number;
	truncated: boolean;
	readFailed: boolean;
}

/** Strip terminal controls even when escape sequences span stream chunks. */
class TerminalTextFilter {
	private mode: 'text' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'text';
	private carriageReturn = false;

	append(raw: string): string {
		const text: string[] = [];
		for (const char of raw) {
			if (this.mode === 'stringEscape') {
				this.mode = char === '\\' ? 'text' : char === '\x1b' ? 'stringEscape' : 'string';
			} else if (this.mode === 'string') {
				if (char === '\x07' || char === '\x9c') { this.mode = 'text'; }
				else if (char === '\x1b') { this.mode = 'stringEscape'; }
			} else if (this.mode === 'csi') {
				if (char >= '@' && char <= '~') { this.mode = 'text'; }
				else if (char === '\x1b') { this.mode = 'escape'; }
			} else if (this.mode === 'escape') {
				if (char === '[') { this.mode = 'csi'; }
				else if (']PX^_'.includes(char)) { this.mode = 'string'; }
				else if (char >= '0' && char <= '~') { this.mode = 'text'; }
			} else if (char === '\x1b') { this.mode = 'escape'; }
			else if (char === '\x9b') { this.mode = 'csi'; }
			else if ('\x90\x98\x9d\x9e\x9f'.includes(char)) { this.mode = 'string'; }
			else if (char === '\r') {
				text.push('\n'); this.carriageReturn = true;
			} else if (char === '\n') {
				if (!this.carriageReturn) { text.push(char); }
				this.carriageReturn = false;
			} else if (char === '\t' || (char >= ' ' && !(char >= '\x7f' && char <= '\x9f'))) {
				this.carriageReturn = false;
				text.push(char);
			}
		}
		return text.join('');
	}
}

/**
 * Capture shell-integration output in memory. Only an explicit terminal attachment
 * or mention reads it into a prompt; no commands are run or terminal history replayed.
 */
export class TerminalCaptureBuffer implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly perTerminal = new Map<vscode.Terminal, CaptureState>();
	private disposed = false;

	constructor() {
		this.disposables.push(vscode.window.onDidStartTerminalShellExecution(event => this.onStart(event)));
		this.disposables.push(vscode.window.onDidEndTerminalShellExecution(event => {
			const state = this.perTerminal.get(event.terminal);
			if (state?.execution !== event.execution) { return; }
			state.running = false;
			state.exitCode = event.exitCode;
			state.commandLine = event.execution.commandLine.value;
		}));
		this.disposables.push(vscode.window.onDidCloseTerminal(terminal => this.perTerminal.delete(terminal)));
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('sota.terminal.shellIntegration') && !this.enabled()) {
				this.perTerminal.clear();
			}
		}));
	}

	/** Read the latest command using the current user-selected line limit. */
	lastOutputFor(terminal: vscode.Terminal): CapturedTerminalOutput | undefined {
		const state = this.enabled() ? this.perTerminal.get(terminal) : undefined;
		if (!state) { return undefined; }
		const lineCap = vscode.workspace.getConfiguration('sota.terminal').get<number>('outputLineCap', 100);
		const output = trimToBudget(state.output, lineCap);
		return { commandLine: state.commandLine, output, running: state.running, exitCode: state.exitCode, truncated: state.truncated || output !== state.output, readFailed: state.readFailed };
	}

	dispose(): void {
		this.disposed = true;
		this.perTerminal.clear();
		for (const disposable of this.disposables) { disposable.dispose(); }
		this.disposables.length = 0;
	}

	private enabled(): boolean {
		return !this.disposed && vscode.workspace.getConfiguration('sota.terminal').get<boolean>('shellIntegration', true);
	}

	private onStart(event: vscode.TerminalShellExecutionStartEvent): void {
		if (!this.enabled()) { return; }
		const state: CaptureState = { execution: event.execution, cleaner: new TerminalTextFilter(), commandLine: event.execution.commandLine.value, output: '', running: true, truncated: false, readFailed: false };
		this.perTerminal.set(event.terminal, state);
		void this.drain(event.terminal, state);
	}

	private async drain(terminal: vscode.Terminal, state: CaptureState): Promise<void> {
		try {
			// read() must be called synchronously in the start event to avoid lost data.
			for await (const data of state.execution.read()) {
				if (this.perTerminal.get(terminal) !== state || !this.enabled()) { break; }
				const combined = state.output + state.cleaner.append(data);
				state.output = trimToBudget(combined, MAX_OUTPUT_LINES);
				state.truncated ||= state.output !== combined;
			}
		} catch {
			state.readFailed = true;
		}
		// The end event and final data can arrive in either order. Keep updating
		// this exact state until the stream drains; a newer execution supersedes it.
	}
}

/** Keep the latest lines within 16 KiB, preserving UTF-8 character boundaries. */
export function trimToBudget(text: string, lineCap = 100): string {
	if (!text) { return ''; }
	const cap = Number.isFinite(lineCap) ? Math.max(20, Math.min(MAX_OUTPUT_LINES, Math.floor(lineCap))) : 100;
	const lines = text.split('\n');
	const trailingNewline = lines.at(-1) === '';
	if (trailingNewline) { lines.pop(); }
	const out = lines.slice(-cap).join('\n') + (trailingNewline ? '\n' : '');
	const bytes = Buffer.from(out, 'utf8');
	if (bytes.length <= MAX_OUTPUT_BYTES) { return out; }
	let offset = bytes.length - MAX_OUTPUT_BYTES;
	while ((bytes[offset] & 0xc0) === 0x80) { offset++; }
	return bytes.subarray(offset).toString('utf8');
}
