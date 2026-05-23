// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import { SseParser } from './providers/anthropic-stream.js';

export interface StreamUsageSummary {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadInputTokens: number;
	readonly cacheCreationInputTokens: number;
}

interface AnthropicUsageFields {
	input_tokens?: number;
	output_tokens?: number;
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
}

function applyUsageFields(fields: AnthropicUsageFields, acc: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }): void {
	acc.inputTokens += fields.input_tokens ?? 0;
	acc.outputTokens += fields.output_tokens ?? 0;
	acc.cacheReadInputTokens += fields.cache_read_input_tokens ?? 0;
	acc.cacheCreationInputTokens += fields.cache_creation_input_tokens ?? 0;
}

function extractUsageFromEvent(event: unknown): AnthropicUsageFields | undefined {
	if (typeof event !== 'object' || event === null) {
		return undefined;
	}
	const e = event as Record<string, unknown>;
	if (e['type'] === 'message_start') {
		const msg = e['message'] as Record<string, unknown> | undefined;
		if (msg && typeof msg['usage'] === 'object' && msg['usage'] !== null) {
			return msg['usage'] as AnthropicUsageFields;
		}
	}
	if (e['type'] === 'message_delta') {
		if (typeof e['usage'] === 'object' && e['usage'] !== null) {
			return e['usage'] as AnthropicUsageFields;
		}
	}
	return undefined;
}

/**
 * Wraps an AsyncIterable<Buffer> (a streaming HTTP response body) and
 * passes each chunk through unchanged while parsing Anthropic SSE events
 * as a side effect. When the stream ends, `onUsage` is called with the
 * accumulated token counts extracted from `message_start` and `message_delta`
 * events.
 *
 * Works as a no-op for non-Anthropic providers: their SSE payloads contain
 * neither `message_start` nor `message_delta` event types, so all usage
 * counts remain zero and `onUsage` is still called (with zeros) at stream end.
 */
export async function* passthroughCollectUsage(
	chunks: AsyncIterable<Buffer>,
	onUsage: (summary: StreamUsageSummary) => void,
): AsyncIterable<Buffer> {
	const parser = new SseParser();
	const acc = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
	};

	for await (const chunk of chunks) {
		const events = parser.feed(chunk.toString('utf-8'));
		for (const event of events) {
			const usageFields = extractUsageFromEvent(event);
			if (usageFields) {
				applyUsageFields(usageFields, acc);
			}
		}
		yield chunk;
	}

	onUsage({
		inputTokens: acc.inputTokens,
		outputTokens: acc.outputTokens,
		cacheReadInputTokens: acc.cacheReadInputTokens,
		cacheCreationInputTokens: acc.cacheCreationInputTokens,
	});
}
