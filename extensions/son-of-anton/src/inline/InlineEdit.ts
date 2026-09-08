/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { LlmClient, ModelId } from 'son-of-anton-core/llm/LlmClient';

/**
 * Provides inline edit functionality triggered by Cmd+K / Ctrl+K.
 * Expands selection to the nearest logical block, prompts for an instruction,
 * sends context to the LLM, and renders a diff for accept/reject.
 */
export class InlineEditProvider implements vscode.Disposable {
	private readonly previews = new Map<string, string>();
	private readonly registration: vscode.Disposable;
	private activeRequest: AbortController | undefined;
	private disposed = false;

	constructor(private readonly llmClient: LlmClient) {
		this.registration = vscode.workspace.registerTextDocumentContentProvider('sota-inline-preview', {
			provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? '',
		});
	}

	dispose(): void {
		this.disposed = true;
		this.activeRequest?.abort();
		this.previews.clear();
		this.registration.dispose();
	}

	async provideInlineEdit(): Promise<void> {
		if (this.disposed) {
			return;
		}
		if (this.activeRequest) {
			void vscode.window.showInformationMessage(vscode.l10n.t('Finish or discard the current inline edit first.'));
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.scheme === 'sota-inline-preview') {
			void vscode.window.showWarningMessage(vscode.l10n.t('Open a source file to start an inline edit.'));
			return;
		}
		const document = editor.document;
		const selection = editor.selection.isEmpty ? this.expandToBlock(editor) : editor.selection;
		const original = document.getText();
		const version = document.version;
		const selectedText = document.getText(selection);
		if (!selectedText.trim()) {
			void vscode.window.showWarningMessage(vscode.l10n.t('Select some code to edit.'));
			return;
		}
		const controller = new AbortController();
		this.activeRequest = controller;
		try {
			const instruction = await vscode.window.showInputBox({
				prompt: vscode.l10n.t('Describe the edit. You can review the full diff before applying it.'),
				placeHolder: vscode.l10n.t('For example, add error handling…'),
			});
			if (!instruction?.trim() || controller.signal.aborted) {
				return;
			}
			if (document.isClosed || document.version !== version) {
				this.showStaleEditWarning();
				return;
			}
			const start = document.offsetAt(selection.start);
			const end = document.offsetAt(selection.end);
			const prompt = this.buildPrompt({
				filePath: document.fileName,
				language: document.languageId,
				selectedCode: selectedText,
				beforeContext: original.slice(document.offsetAt(new vscode.Position(Math.max(0, selection.start.line - 50), 0)), start),
				afterContext: original.slice(end, document.offsetAt(document.lineAt(Math.min(document.lineCount - 1, selection.end.line + 50)).range.end)),
				instruction,
			});
			const result = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: vscode.l10n.t('Son of Anton: Generating Edit…'),
				cancellable: true,
			}, async (_progress, cancellationToken) => {
				const subscription = cancellationToken.onCancellationRequested(() => controller.abort());
				try {
					if (cancellationToken.isCancellationRequested) {
						controller.abort();
					}
					return await this.llmClient.request({
						model: vscode.workspace.getConfiguration('sota').get<ModelId>('defaultModel', 'sonnet'),
						messages: [{ role: 'user', content: prompt }],
						systemPrompt: 'You are a code editing assistant. Return ONLY the modified code with no explanations, no markdown fences, no surrounding text. The code should be a direct replacement for the selected region. Preserve leading indentation and trailing newlines.',
						signal: controller.signal,
					});
				} finally {
					subscription.dispose();
				}
			});
			if (controller.signal.aborted) {
				return;
			}
			// Remove only an enclosing markdown fence, never meaningful code whitespace.
			const fenced = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(result);
			const replacement = (fenced ? fenced[1] : result).replace(/\r?\n/g, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
			if (!replacement.trim()) {
				void vscode.window.showWarningMessage(vscode.l10n.t('The model returned no code. Try a more specific instruction.'));
				return;
			}
			if (replacement === selectedText) {
				void vscode.window.showInformationMessage(vscode.l10n.t('The suggested code already matches your selection.'));
				return;
			}
			await this.showDiff(editor, selection, original, version, replacement, start, end, controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Inline edit failed: {0}', String(error)));
			}
		} finally {
			this.activeRequest = undefined;
		}
	}

	private showStaleEditWarning(): void {
		void vscode.window.showWarningMessage(vscode.l10n.t('The file changed while this edit was being prepared. Run Inline Edit again to use the latest version.'));
	}

	/**
	 * Expand an empty selection to the nearest logical block
	 * (function, class, or paragraph of code).
	 */
	private expandToBlock(editor: vscode.TextEditor): vscode.Selection {
		const document = editor.document;
		const position = editor.selection.active;
		const line = position.line;
		const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;

		// Try to find a function/class boundary using indentation
		const currentIndent = this.getIndentLevel(document.lineAt(line).text, tabSize);

		let startLine = line;
		let endLine = line;

		// Walk up to find the start of the block
		for (let i = line - 1; i >= 0; i--) {
			const lineText = document.lineAt(i).text;
			if (lineText.trim() === '') {
				// Empty line — check if we've found a meaningful boundary
				if (startLine !== line) {
					break;
				}
				continue;
			}
			const indent = this.getIndentLevel(lineText, tabSize);
			if (indent < currentIndent) {
				startLine = i;
				break;
			}
			startLine = i;
		}

		// Walk down to find the end of the block
		for (let i = line + 1; i < document.lineCount; i++) {
			const lineText = document.lineAt(i).text;
			if (lineText.trim() === '') {
				if (endLine !== line) {
					break;
				}
				continue;
			}
			const indent = this.getIndentLevel(lineText, tabSize);
			if (indent < currentIndent) {
				break;
			}
			endLine = i;
		}

		return new vscode.Selection(
			startLine, 0,
			endLine, document.lineAt(endLine).text.length
		);
	}

	private getIndentLevel(line: string, tabSize: number): number {
		let count = 0;
		for (const ch of line) {
			if (ch === '\t') {
				count += tabSize;
			} else if (ch === ' ') {
				count += 1;
			} else {
				break;
			}
		}
		return count;
	}

	private buildPrompt(params: {
		filePath: string;
		language: string;
		selectedCode: string;
		beforeContext: string;
		afterContext: string;
		instruction: string;
	}): string {
		return [
			`File: ${params.filePath}`,
			`Language: ${params.language}`,
			'',
			'=== Code before selection ===',
			params.beforeContext,
			'=== Selected code (to be modified) ===',
			params.selectedCode,
			'=== Code after selection ===',
			params.afterContext,
			'',
			`Instruction: ${params.instruction}`,
			'',
			'Return the modified version of the selected code. Keep the same indentation style and conventions.',
		].join('\n');
	}

	/** Keep review actions available while the diff is open, even after its toast hides. */
	private requestReview(before: vscode.Uri, after: vscode.Uri, filename: string, signal: AbortSignal): Promise<boolean> {
		return new Promise(resolve => {
			const disposables: vscode.Disposable[] = [];
			let settled = false;
			const finish = (accepted: boolean) => {
				if (settled) return;
				settled = true;
				for (const disposable of disposables) disposable.dispose();
				resolve(accepted);
			};
			const cancel = () => finish(false);
			signal.addEventListener('abort', cancel, { once: true });
			disposables.push({ dispose: () => signal.removeEventListener('abort', cancel) });
			const accept = vscode.l10n.t('Apply Edit');
			const discard = vscode.l10n.t('Discard Edit');
			const actions = [{ label: accept, icon: 'check', accepted: true }, { label: discard, icon: 'close', accepted: false }];
			for (const [index, action] of actions.entries()) {
				const command = 'sota.inlineReview.' + randomUUID();
				disposables.push(vscode.commands.registerCommand(command, () => finish(action.accepted)));
				const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000 - index);
				disposables.push(item);
				item.name = action.label;
				item.text = '$(' + action.icon + ') ' + action.label;
				item.tooltip = vscode.l10n.t('{0}: {1}', action.label, filename);
				item.command = command;
				item.show();
			}
			disposables.push(vscode.window.tabGroups.onDidChangeTabs(event => {
				if (event.closed.some(tab => tab.input instanceof vscode.TabInputTextDiff
					&& tab.input.original.toString() === before.toString() && tab.input.modified.toString() === after.toString())) finish(false);
			}));
			if (signal.aborted) { cancel(); return; }
			void vscode.window.showInformationMessage(vscode.l10n.t('Review the proposed changes to {0}.', filename), accept, discard)
				.then(choice => finish(choice === accept), () => finish(false));
		});
	}

	/** Review immutable full-file snapshots before applying one undoable edit. */
	private async showDiff(
		editor: vscode.TextEditor,
		selection: vscode.Selection,
		original: string,
		version: number,
		replacement: string,
		start: number,
		end: number,
		signal: AbortSignal,
	): Promise<void> {
		if (editor.document.isClosed || editor.document.version !== version) {
			this.showStaleEditWarning();
			return;
		}
		const id = randomUUID();
		const filename = path.basename(editor.document.fileName);
		const before = vscode.Uri.from({ scheme: 'sota-inline-preview', authority: id, path: '/original/' + filename });
		const after = vscode.Uri.from({ scheme: 'sota-inline-preview', authority: id, path: '/proposed/' + filename });
		this.previews.set(before.toString(), original);
		this.previews.set(after.toString(), original.slice(0, start) + replacement + original.slice(end));
		try {
			await vscode.commands.executeCommand('vscode.diff', before, after,
				vscode.l10n.t('{0} — Proposed Edit', filename), { preview: true, selection, viewColumn: vscode.ViewColumn.Beside });
			if (signal.aborted) {
				return;
			}
			const accepted = await this.requestReview(before, after, filename, signal);
			if (!accepted || signal.aborted) {
				return;
			}
			if (editor.document.isClosed || editor.document.version !== version) {
				this.showStaleEditWarning();
				return;
			}
			// TextEditor.edit carries the document version across the extension-host
			// boundary; a concurrent edit during application is rejected by VS Code.
			const applied = await editor.edit(builder => builder.replace(selection, replacement), { undoStopBefore: true, undoStopAfter: true });
			if (!applied) {
				this.showStaleEditWarning();
				return;
			}
			await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection, preserveFocus: false });
		} finally {
			const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab =>
				tab.input instanceof vscode.TabInputTextDiff && tab.input.original.toString() === before.toString() && tab.input.modified.toString() === after.toString());
			try {
				if (tabs.length) {
					await vscode.window.tabGroups.close(tabs, true);
				}
			} finally {
				this.previews.delete(before.toString());
				this.previews.delete(after.toString());
			}
		}
	}
}
