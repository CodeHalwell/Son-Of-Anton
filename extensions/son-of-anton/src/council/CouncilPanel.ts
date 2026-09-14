/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** Small document shell; UI state arrives only after the webview ready handshake. */
export function councilHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const nonce = randomBytes(16).toString('hex');
	const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'council.js'));
	const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'council.css'));
	const labels = JSON.stringify({
		title: vscode.l10n.t('AI Council'), help: vscode.l10n.t('Independent reviews, visible disagreement, and a separate synthesis.'),
		objective: vscode.l10n.t('Review Objective'), objectiveHint: vscode.l10n.t('Review the changes for correctness, missing tests, and security issues.'),
		group: vscode.l10n.t('Saved Group'), revision: vscode.l10n.t('Compare with Revision'), rounds: vscode.l10n.t('Rounds'),
		finalReview: vscode.l10n.t('Include Independent Final Review'), start: vscode.l10n.t('Start Review'), groups: vscode.l10n.t('Edit Groups'),
		refresh: vscode.l10n.t('Refresh'), history: vscode.l10n.t('Council History'), loading: vscode.l10n.t('Loading Council reports…'),
		empty: vscode.l10n.t('No Council reviews yet. Start a review of your tracked changes.'),
		cancel: vscode.l10n.t('Cancel Review'), export: vscode.l10n.t('Export Markdown'), promote: vscode.l10n.t('Add Findings to Board'),
		evidence: vscode.l10n.t('Open Evidence'), disagreements: vscode.l10n.t('Disagreements'), questions: vscode.l10n.t('Unanswered Questions'),
		usage: vscode.l10n.t('Usage unavailable'), raw: vscode.l10n.t('Partial / Raw Response'), scope: vscode.l10n.t('Captured Review Scope'),
		readOnly: vscode.l10n.t('Reviews the captured tracked diff using your configured providers. Council grants no tool permissions; external adapters must support a read-only mode.'),
		noSelection: vscode.l10n.t('Select a review to see its findings and member reports.'),
		complete: vscode.l10n.t('Completed'), running: vscode.l10n.t('Running'), pending: vscode.l10n.t('Pending'), failed: vscode.l10n.t('Failed'), cancelled: vscode.l10n.t('Cancelled'),
		'quorum-failed': vscode.l10n.t('Quorum Not Reached'), 'chair-failed': vscode.l10n.t('Synthesis Failed'), 'review-failed': vscode.l10n.t('Final Review Failed'), 'timed-out': vscode.l10n.t('Timed Out'), interrupted: vscode.l10n.t('Interrupted'),
		member: vscode.l10n.t('Member'), chair: vscode.l10n.t('Chair'), reviewer: vscode.l10n.t('Independent Reviewer'),
		round: vscode.l10n.t('Round {0}'), tokens: vscode.l10n.t('{0} input · {1} output tokens · billing unavailable'),
		progress: vscode.l10n.t('{0} of {1} stages completed'), parameters: vscode.l10n.t('{0} members · quorum {1} · concurrency {2} · {3} minute limit'),
	}).replace(/</g, '\\u003c');
	return /* html */`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"><title>AI Council</title></head><body>
	<header><div><h1 data-label="title"></h1><p data-label="help"></p></div><button id="refresh" data-label="refresh"></button></header>
	<div id="error" role="alert" hidden></div>
	<main><section class="setup" aria-labelledby="setupTitle"><h2 id="setupTitle" data-label="objective"></h2>
	<form id="startForm"><label><span data-label="objective"></span><textarea name="objective" autocomplete="off" id="objective" maxlength="8000" required rows="3"></textarea></label>
	<div class="fields"><label><span data-label="group"></span><select name="group" id="group" required></select></label><label><span data-label="revision"></span><input name="revision" autocomplete="off" id="revision" value="HEAD" maxlength="256" required spellcheck="false"></label><label><span data-label="rounds"></span><input name="rounds" inputmode="numeric" id="rounds" type="number" min="1" max="3" value="1" required></label></div>
	<label class="check"><input type="checkbox" id="finalReview"><span data-label="finalReview"></span></label><p id="parameters"></p><p class="muted" data-label="readOnly"></p>
	<div class="actions"><button id="start" type="submit" class="primary" data-label="start" disabled></button><button id="groups" type="button" data-label="groups"></button></div></form></section>
	<div class="results"><aside aria-labelledby="historyTitle"><h2 id="historyTitle" data-label="history"></h2><div id="history" role="list"></div></aside><section id="report" aria-live="polite"></section></div></main>
	<script type="application/json" nonce="${nonce}" id="labels">${labels}</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
}
