/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildCachedRequest } from './buildCachedRequest.js';
import type { LlmMessage } from './LlmClient.js';

const USER_TURN: LlmMessage = { role: 'user', content: 'What does main() do?' };
const ASSISTANT_TURN: LlmMessage = { role: 'assistant', content: 'It is the entry point.' };

describe('buildCachedRequest', () => {
	test('places cache breakpoints on all three static slots', () => {
		const result = buildCachedRequest(
			'claude-sonnet-4-6',
			{
				systemPrompt: 'You are a code reviewer.',
				projectMemory: 'CLAUDE.md: use tabs.',
				graphContext: 'Function foo() calls bar().',
			},
			[USER_TURN],
		);

		assert.deepStrictEqual(result.systemPromptParts, [
			{ text: 'You are a code reviewer.', cache: 'ephemeral' },
			{ text: 'CLAUDE.md: use tabs.', cache: 'ephemeral' },
			{ text: 'Function foo() calls bar().', cache: 'ephemeral' },
		]);
		assert.deepStrictEqual(result.messages, [USER_TURN]);
		assert.strictEqual(result.model, 'claude-sonnet-4-6');
	});

	test('omits breakpoints for absent optional slots', () => {
		const result = buildCachedRequest(
			'claude-haiku-4-5',
			{ systemPrompt: 'You are a helper.' },
			[USER_TURN],
		);

		assert.deepStrictEqual(result.systemPromptParts, [
			{ text: 'You are a helper.', cache: 'ephemeral' },
		]);
	});

	test('omits breakpoints for empty optional slot strings', () => {
		const result = buildCachedRequest(
			'claude-sonnet-4-6',
			{ systemPrompt: 'Role.', projectMemory: '', graphContext: 'ctx' },
			[USER_TURN],
		);

		assert.deepStrictEqual(result.systemPromptParts, [
			{ text: 'Role.', cache: 'ephemeral' },
			{ text: 'ctx', cache: 'ephemeral' },
		]);
	});

	test('preserves conversation order', () => {
		const result = buildCachedRequest(
			'claude-opus-4-7',
			{ systemPrompt: 'Role.' },
			[USER_TURN, ASSISTANT_TURN, USER_TURN],
		);

		assert.deepStrictEqual(result.messages, [USER_TURN, ASSISTANT_TURN, USER_TURN]);
	});

	test('forwards override fields without clobbering model/messages/systemPromptParts', () => {
		const signal = new AbortController().signal;
		const result = buildCachedRequest(
			'claude-sonnet-4-6',
			{ systemPrompt: 'Role.' },
			[USER_TURN],
			{ maxTokens: 512, agentHandle: 'reviewer', signal },
		);

		assert.strictEqual(result.maxTokens, 512);
		assert.strictEqual(result.agentHandle, 'reviewer');
		assert.strictEqual(result.signal, signal);
		assert.strictEqual(result.model, 'claude-sonnet-4-6');
	});

	test('returns a copy of the conversation array (not the same reference)', () => {
		const conv = [USER_TURN];
		const result = buildCachedRequest('claude-sonnet-4-6', { systemPrompt: 'Role.' }, conv);
		assert.notStrictEqual(result.messages, conv);
	});
});
