/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getStartupQuote, formatQuoteShort } from 'son-of-anton-core/personality/siliconValleyQuotes';
import { getStaticArt } from 'son-of-anton-core/personality/asciiArt';
import { isPersonalityEnabled } from './personalityConfig';

/**
 * Logs a multi-line activation banner (Pied Piper logo + tagline + the
 * quote-of-the-day) to the dedicated "Son of Anton" output channel and
 * keeps the legacy status-bar one-liner behaviour for backward
 * compatibility.
 *
 * The banner is logged silently so the workspace and chat keep their space.
 */
export class StartupMessages {
	private static readonly DISPLAY_DURATION_MS = 8000;
	private static channel: vscode.OutputChannel | undefined;

	/**
	 * Displays the startup messages. `context` is optional so existing
	 * callers (and tests) that only have an `extensionUri` keep working;
	 * when present it owns the output channel lifetime.
	 */
	static async show(
		extensionUri: vscode.Uri,
		context?: vscode.ExtensionContext,
	): Promise<void> {
		if (!isPersonalityEnabled()) {
			return;
		}

		const channel = this.getChannel();
		if (context) {
			context.subscriptions.push({ dispose: () => {
				channel.dispose();
				if (this.channel === channel) { this.channel = undefined; }
			} });
		}
		this.logBanner();

		const messages = await this.loadMessages(extensionUri);
		if (messages.length === 0) {
			return;
		}

		// On Friday after 4pm, add the Friday afternoon message
		const now = new Date();
		if (now.getDay() === 5 && now.getHours() >= 16) {
			const strings = await this.loadStrings(extensionUri);
			if (strings.fridayAfternoon) {
				messages.push(strings.fridayAfternoon);
			}
		}

		const message = messages[Math.floor(Math.random() * messages.length)];
		vscode.window.setStatusBarMessage(`$(hubot) ${message}`, this.DISPLAY_DURATION_MS);
	}

	/**
	 * Lazily creates and returns the dedicated output channel.
	 */
	static getChannel(): vscode.OutputChannel {
		if (!this.channel) {
			this.channel = vscode.window.createOutputChannel('Son of Anton');
		}
		return this.channel;
	}

	private static logBanner(): void {
		const channel = this.getChannel();
		const quote = getStartupQuote();

		channel.appendLine('');
		channel.appendLine(getStaticArt('piedPiperLogo'));
		channel.appendLine('');
		channel.appendLine('   Son of Anton -- middle out compression for your IDE');
		channel.appendLine('');
		channel.appendLine(`   Today's quote:  ${formatQuoteShort(quote)}`);
		if (quote.context) {
			channel.appendLine(`                   (${quote.context})`);
		}
		channel.appendLine('');

	}

	private static async loadMessages(extensionUri: vscode.Uri): Promise<string[]> {
		try {
			const messagesUri = vscode.Uri.joinPath(extensionUri, 'resources', 'startup-messages.json');
			const content = await vscode.workspace.fs.readFile(messagesUri);
			return JSON.parse(Buffer.from(content).toString('utf-8'));
		} catch {
			return [];
		}
	}

	private static async loadStrings(extensionUri: vscode.Uri): Promise<Record<string, string>> {
		try {
			const stringsUri = vscode.Uri.joinPath(extensionUri, 'resources', 'strings.json');
			const content = await vscode.workspace.fs.readFile(stringsUri);
			return JSON.parse(Buffer.from(content).toString('utf-8'));
		} catch {
			return {};
		}
	}
}
