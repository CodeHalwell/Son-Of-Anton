/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isOpenAIReasoningModel, supportsAgenticToolLoop } from './LlmClient.js';

// Reasoning models require `max_completion_tokens` + the `developer` role;
// classic chat models require `max_tokens` + the `system` role. Misclassifying
// either direction produces an HTTP 400 from the OpenAI API, so pin the whole
// OpenAI model set here.
const REASONING_MODELS = [
	'o1',
	'o1-mini',
	'o1-pro',
	'o3',
	'o3-mini',
	'o4-mini',
	'gpt-5',
	'gpt-5-mini',
	'gpt-5-nano',
	'gpt-5-codex',
] as const;

const CLASSIC_MODELS = [
	'gpt-4o',
	'gpt-4o-mini',
	'gpt-4-1',
	'gpt-4-1-mini',
	'gpt-4-1-nano',
	'gpt-4-turbo',
	'gpt-3-5-turbo',
] as const;

describe('isOpenAIReasoningModel', () => {
	test('classifies every OpenAI reasoning model as reasoning', () => {
		const misclassified = REASONING_MODELS.filter(m => !isOpenAIReasoningModel(m));
		assert.deepStrictEqual(misclassified, []);
	});

	test('classifies every classic OpenAI chat model as non-reasoning', () => {
		const misclassified = CLASSIC_MODELS.filter(m => isOpenAIReasoningModel(m));
		assert.deepStrictEqual(misclassified, []);
	});

	test('does not treat Anthropic or Gemini reasoning models as OpenAI reasoning', () => {
		// These have a `reasoning` capability but are not OpenAI o-/gpt-5 models,
		// so they must not be routed through the max_completion_tokens path.
		const others = ['claude-opus-4-7', 'claude-sonnet-4-6', 'gemini-2-5-pro', 'ollama-deepseek-r1'] as const;
		const misclassified = others.filter(m => isOpenAIReasoningModel(m));
		assert.deepStrictEqual(misclassified, []);
	});
});

describe('supportsAgenticToolLoop', () => {
	test('Anthropic-shaped providers can drive the tool loop', () => {
		// Anthropic and Bedrock Claude round-trip tool_use / tool_result parts.
		const capable = ['opus', 'sonnet', 'haiku', 'claude-opus-4-7', 'claude-3-5-sonnet', 'bedrock-claude-sonnet-4'] as const;
		const rejected = capable.filter(m => !supportsAgenticToolLoop(m));
		assert.deepStrictEqual(rejected, []);
	});

	test('OpenAI-compatible and Gemini serializers support tool loops', () => {
		const capable = ['gpt-5', 'gpt-4o', 'o3', 'gemini-2-5-pro', 'foundry-gpt-4o'] as const;
		assert.deepStrictEqual(capable.filter(model => !supportsAgenticToolLoop(model)), []);
	});

	test('subscription CLIs and unsupported Bedrock families do not use the native tool loop', () => {
		const external = ['claude-code-sonnet', 'codex-gpt-5', 'bedrock-nova-pro', 'bedrock-llama-3-1-70b'] as const;
		assert.deepStrictEqual(external.filter(model => supportsAgenticToolLoop(model)), []);
	});
});
