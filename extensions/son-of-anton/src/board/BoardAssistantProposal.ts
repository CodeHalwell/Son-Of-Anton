/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { isWebviewToHostMessage, type BoardActionMessage } from './webview/protocol';

/** ACP returns text proposals; the host validates these before the existing Board confirmation flow. */
export function parseBoardAssistantProposal(text: string): { text: string; actions: BoardActionMessage[] } {
	const match = /(?:^|\n)```board-actions\s*\n([\s\S]*?)\n```\s*$/.exec(text);
	if (!match) { return { text, actions: [] }; }
	let values: Array<Record<string, unknown>>;
	try { values = JSON.parse(match[1]) as Array<Record<string, unknown>>; }
	catch { throw new Error('Board assistant returned malformed proposed actions. No changes were made.'); }
	if (!Array.isArray(values) || values.length > 10) { throw new Error('Board assistant may propose at most ten changes at a time.'); }
	const actions = values.map(value => ({ ...value, type: 'board-action' }));
	if (actions.some(value => !isWebviewToHostMessage(value))) { throw new Error('Board assistant proposed an unsupported action. No changes were made.'); }
	return { text: text.slice(0, match.index).trim(), actions: actions as BoardActionMessage[] };
}
