/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { LlmClient, ModelId } from 'son-of-anton-core/llm/LlmClient';

/** Language IDs where completions are disabled by default. */
const EXCLUDED_LANGUAGES = new Set(['json', 'jsonc', 'plaintext', 'log']);

/**
 * Provides ghost-text inline completions using the configured completion model.
 * Debounces requests and cancels stale ones automatically.
 */
export class CompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
	private readonly llmClient: LlmClient;
	private pendingAbort: AbortController | undefined;
	private disposed = false;

	constructor(llmClient: LlmClient) {
		this.llmClient = llmClient;
	}

	dispose(): void {
		this.disposed = true;
		this.pendingAbort?.abort();
		this.pendingAbort = undefined;
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		// Every new cursor state invalidates the preceding request, including
		// moves into excluded languages and comments.
		this.pendingAbort?.abort();
		this.pendingAbort = undefined;
		if (this.disposed || token.isCancellationRequested || document.isClosed || document.uri.scheme === 'sota-inline-preview') {
			return undefined;
		}
		const version = document.version;
		// Check if completions are enabled
		const config = vscode.workspace.getConfiguration('sota');
		if (!config.get<boolean>('completions.enabled', true)) {
			return undefined;
		}

		// Skip excluded languages
		if (EXCLUDED_LANGUAGES.has(document.languageId)) {
			return undefined;
		}

		// Skip if in a comment or string (basic heuristic)
		const lineText = document.lineAt(position.line).text;
		const textBeforeCursor = lineText.substring(0, position.character);
		if (this.isInCommentOrString(textBeforeCursor, document.languageId)) {
			return undefined;
		}

		const controller = new AbortController();
		this.pendingAbort = controller;
		const signal = controller.signal;
		const cancellation = token.onCancellationRequested(() => controller.abort());
		try {
			const configuredDelay = config.get<number>('completions.debounceMs', 300);
			const debounceMs = Number.isFinite(configuredDelay) ? Math.max(0, Math.min(2000, configuredDelay)) : 300;
			await new Promise<void>(resolve => {
				const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
				const timer = setTimeout(finish, debounceMs);
				signal.addEventListener('abort', finish, { once: true });
				if (signal.aborted) finish();
			});
			if (token.isCancellationRequested || signal.aborted || document.isClosed || document.version !== version) {
				return undefined;
			}

			// Gather context: prefix and suffix around cursor
			const maxContextLines = 100;
			const startLine = Math.max(0, position.line - maxContextLines);
			const endLine = Math.min(document.lineCount - 1, position.line + maxContextLines);

			const prefix = document.getText(
				new vscode.Range(startLine, 0, position.line, position.character)
			);
			const suffixEnd = document.lineAt(endLine).range.end;
			const suffix = document.getText(
				new vscode.Range(position, suffixEnd)
			);

			const prompt = [
				`File: ${document.fileName}`,
				`Language: ${document.languageId}`,
				'',
				'Complete the code at the cursor position marked with <CURSOR>. Return ONLY the completion text, nothing else.',
				'',
				prefix + '<CURSOR>' + suffix,
			].join('\n');

			const completion = await this.llmClient.request({
				model: config.get<ModelId>('completions.model') || config.get<ModelId>('defaultModel', 'sonnet'),
				messages: [{ role: 'user', content: prompt }],
				systemPrompt: 'You are an inline code completion engine. Return ONLY the code that should be inserted at the cursor position. No explanations, no markdown, no surrounding code. Just the completion text.',
				maxTokens: 256,
				signal,
			});

			if (token.isCancellationRequested || signal.aborted || document.isClosed || document.version !== version) {
				return undefined;
			}

			// Whitespace can complete an indentation level or separate tokens.
			if (!completion.trim()) {
				return undefined;
			}

			return [
				new vscode.InlineCompletionItem(
					completion,
					new vscode.Range(position, position),
				),
			];
		} catch {
			return undefined;
		} finally {
			cancellation.dispose();
			if (this.pendingAbort === controller) this.pendingAbort = undefined;
		}
	}

	/**
	 * Basic heuristic to detect if cursor is inside a comment or string.
	 */
	private isInCommentOrString(textBeforeCursor: string, _languageId: string): boolean {
		const trimmed = textBeforeCursor.trimStart();

		// Line comments
		if (trimmed.startsWith('//') || trimmed.startsWith('#')) {
			return true;
		}

		// Count unescaped quotes to detect if we're inside a string
		let singleQuotes = 0;
		let doubleQuotes = 0;
		let backticks = 0;
		for (let i = 0; i < textBeforeCursor.length; i++) {
			const ch = textBeforeCursor[i];
			if (ch === '\\') {
				i++; // skip escaped character
				continue;
			}
			if (ch === '\'') {
				singleQuotes++;
			}
			if (ch === '"') {
				doubleQuotes++;
			}
			if (ch === '`') {
				backticks++;
			}
		}

		// Odd count means we're inside a string
		return (singleQuotes % 2 !== 0) || (doubleQuotes % 2 !== 0) || (backticks % 2 !== 0);
	}
}
