/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { strict as assert } from 'assert';
import { isWebviewToHostMessage } from '../src/board/webview/protocol';

suite('Task board message boundary', () => {
	test('rejects invalid states and malformed chat messages before host execution', () => {
		const messages = [null, { type: 'board-action', action: 'setCardStatus', cardId: 'a', toColumn: 'not-a-state' }, { type: 'chat-runtime', requestId: 'r', model: 'sonnet', messages: 'oops' }, { type: 'chat-runtime', requestId: 'r', model: 'sonnet', messages: [{ role: 'user', content: {} }] }];
		assert.deepEqual(messages.map(isWebviewToHostMessage), [false, false, false, false]);
	});
	test('accepts typed execution, cancellation and chat messages', () => {
		const messages = [{ type: 'dispatch', taskId: 'a' }, { type: 'cancel-chat', requestId: 'r' }, { type: 'chat-runtime', requestId: 'r', model: '', messages: [{ role: 'user', content: 'Summarize the board' }] }];
		assert.deepEqual(messages.map(isWebviewToHostMessage), [true, true, true]);
	});
});
