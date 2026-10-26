/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export type ViewMessage =
	| { type: 'ready' | 'refresh' | 'create' | 'disconnect' | 'reconnect' }
	| { type: 'attach'; sessionId: string }
	| { type: 'submit'; sessionId: string; text: string; mode: 'Ask' | 'Explore' | 'Plan' | 'Build' | 'Review'; requestId: string }
	| { type: 'approve' | 'reject' | 'question' | 'cancel'; sessionId: string; id: string };

/** Webview input is untrusted; it never selects a protocol command directly. */
export function parseViewMessage(value: unknown): ViewMessage | undefined {
	if (!value || typeof value !== 'object') { return undefined; }
	const message = value as Record<string, unknown>;
	if (typeof message.type !== 'string') { return undefined; }
	if (message.type === 'ready' || message.type === 'refresh' || message.type === 'create' || message.type === 'disconnect' || message.type === 'reconnect') { return { type: message.type }; }
	if (typeof message.sessionId !== 'string' || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(message.sessionId)) { return undefined; }
	if (message.type === 'attach') { return { type: 'attach', sessionId: message.sessionId }; }
	if (message.type === 'submit' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 100_000
		&& typeof message.mode === 'string' && ['Ask', 'Explore', 'Plan', 'Build', 'Review'].includes(message.mode)
		&& typeof message.requestId === 'string' && message.requestId.length <= 100) { return message as ViewMessage; }
	if (['approve', 'reject', 'question', 'cancel'].includes(message.type) && typeof message.id === 'string'
		&& /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(message.id)) { return message as ViewMessage; }
	return undefined;
}
