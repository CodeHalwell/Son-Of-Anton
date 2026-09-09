/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { ConversationStore } from './ConversationStore';
import type { ChatMessage } from './ChatPanel';

/** Host-observed turn measurements; absent fields are unavailable rather than zero. */
export interface ResponseExecution {
	route: 'acp' | 'native' | 'orchestrator';
	outcome: 'completed' | 'cancelled' | 'failed';
	latencyMs: number;
	inputTokens?: number;
	outputTokens?: number;
	estimatedCostUsd?: number;
}

function measuredExecution(message: ChatMessage): ResponseExecution | undefined {
	const value = (message as ChatMessage & { execution?: ResponseExecution }).execution;
	if (!value || !['acp', 'native', 'orchestrator'].includes(value.route) || !['completed', 'cancelled', 'failed'].includes(value.outcome) || !Number.isFinite(value.latencyMs) || value.latencyMs < 0) { return undefined; }
	const measured = (number: number | undefined) => typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : undefined;
	return { route: value.route, outcome: value.outcome, latencyMs: value.latencyMs, inputTokens: measured(value.inputTokens), outputTokens: measured(value.outputTokens), estimatedCostUsd: measured(value.estimatedCostUsd) };
}

const textContent = (message: ChatMessage | undefined): string => !message ? '' : typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.text : '').join('\n');

/** User-initiated local evaluation export. No automatic upload or image/credential export. */
export function registerResponseFeedback(context: vscode.ExtensionContext, store: ConversationStore): void {
	context.subscriptions.push(vscode.commands.registerCommand('sota.exportResponseFeedback', async () => {
		const examples = store.search({ scope: 'all', limit: Number.MAX_SAFE_INTEGER }).items.filter(summary => !summary.deletedAt).flatMap(summary => {
			const record = store.load(summary.id);
			if (!record) { return []; }
			return record.messages.flatMap((message, index) => {
				if (message.role !== 'assistant' || !['up', 'down'].includes(message.feedback ?? '')) { return []; }
				const prompt = record.messages.slice(0, index).reverse().find(candidate => candidate.role === 'user');
				return [{ conversationId: summary.id, title: summary.title, archived: summary.archived === true, execution: measuredExecution(message), messageIndex: index, feedback: message.feedback, ratedAt: message.feedbackAt, model: message.model ?? prompt?.model, specialist: message.specialistId, prompt: textContent(prompt), response: textContent(message), usageAvailable: message.usageUnavailable === true ? false : undefined }];
			});
		});
		if (!examples.length) { await vscode.window.showInformationMessage(vscode.l10n.t('Rate a response as helpful or not helpful before exporting feedback.')); return; }
		const runs = examples.flatMap(example => example.execution ? [example.execution] : []);
		const estimatedCosts = runs.flatMap(run => run.estimatedCostUsd !== undefined ? [run.estimatedCostUsd] : []);
		const report = {
			schemaVersion: 1, generatedAt: new Date().toISOString(),
			summary: { rated: examples.length, helpful: examples.filter(example => example.feedback === 'up').length, notHelpful: examples.filter(example => example.feedback === 'down').length },
			outcomes: { completed: runs.filter(run => run.outcome === 'completed').length, cancelled: runs.filter(run => run.outcome === 'cancelled').length, failed: runs.filter(run => run.outcome === 'failed').length, unrecorded: examples.length - runs.length },
			routes: { acp: runs.filter(run => run.route === 'acp').length, native: runs.filter(run => run.route === 'native').length, orchestrator: runs.filter(run => run.route === 'orchestrator').length, unrecorded: examples.length - runs.length },
			metrics: { latencySamples: runs.length, meanLatencyMs: runs.length ? runs.reduce((total, run) => total + run.latencyMs, 0) / runs.length : null, estimatedCostSamples: estimatedCosts.length, estimatedCostUsd: estimatedCosts.length ? estimatedCosts.reduce((total, cost) => total + cost, 0) : null },
			limitations: ['User ratings are not automated correctness checks.', 'Archived conversations are included; Trash is excluded.', 'Unknown measurements are not zero. Costs are estimates for measured routes, not subscription billing.', 'No claim is made about tests passing, accepted file changes or provider billing.', 'Export contains the selected prompt and response text; review before sharing.'], examples,
		};
		const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) });
		await vscode.window.showTextDocument(document, { preview: false });
		// Opening an unsaved document gives the user a concrete review before
		// they choose to save/share it. Nothing is transmitted by this command.
	}));
}
