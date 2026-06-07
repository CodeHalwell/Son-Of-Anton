// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { passthroughCollectUsage } from '../src/streamingMetrics.js';
import type { StreamUsageSummary } from '../src/streamingMetrics.js';

function makeChunks(...pieces: string[]): AsyncIterable<Buffer> {
	return (async function* () {
		for (const piece of pieces) {
			yield Buffer.from(piece, 'utf-8');
		}
	})();
}

function sseEvent(type: string, data: unknown): string {
	return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe('passthroughCollectUsage', () => {
	test('passes all chunks through unchanged', async () => {
		const raw = [
			sseEvent('message_start', { type: 'message_start', message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10 } } }),
			sseEvent('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
		];

		const yielded: Buffer[] = [];
		let summary: StreamUsageSummary | undefined;

		for await (const chunk of passthroughCollectUsage(makeChunks(...raw), s => { summary = s; })) {
			yielded.push(chunk);
		}

		assert.deepStrictEqual(
			yielded.map(b => b.toString()),
			raw,
		);
		assert.ok(summary);
	});

	test('extracts input tokens from message_start', async () => {
		const sse = sseEvent('message_start', {
			type: 'message_start',
			message: {
				id: 'm1',
				model: 'claude-sonnet-4-6',
				usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
			},
		});

		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(sse), s => { summary = s; })) {
			// consume
		}

		assert.deepStrictEqual(summary, {
			inputTokens: 100,
			outputTokens: 0,
			cacheReadInputTokens: 40,
			cacheCreationInputTokens: 10,
		});
	});

	test('extracts output tokens from message_delta', async () => {
		const chunks = [
			sseEvent('message_start', {
				type: 'message_start',
				message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 50 } },
			}),
			sseEvent('message_delta', {
				type: 'message_delta',
				delta: { stop_reason: 'end_turn' },
				usage: { output_tokens: 30 },
			}),
		];

		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(...chunks), s => { summary = s; })) {
			// consume
		}

		assert.deepStrictEqual(summary, {
			inputTokens: 50,
			outputTokens: 30,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});

	test('ignores output_tokens placeholder in message_start (no over-count)', async () => {
		// Real Anthropic streams emit a placeholder `output_tokens` (typically 1)
		// in `message_start.usage`, then the authoritative cumulative count in
		// `message_delta.usage`. Naive `acc.outputTokens += fields.output_tokens ?? 0`
		// over both events would report `placeholder + final` (e.g. 251). The
		// correct count is just the final value (250).
		const chunks = [
			sseEvent('message_start', {
				type: 'message_start',
				message: {
					id: 'm1',
					model: 'claude-sonnet-4-6',
					usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 1 },
				},
			}),
			sseEvent('message_delta', {
				type: 'message_delta',
				delta: { stop_reason: 'end_turn' },
				usage: { output_tokens: 250 },
			}),
		];

		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(...chunks), s => { summary = s; })) {
			// consume
		}

		assert.deepStrictEqual(summary, {
			inputTokens: 100,
			outputTokens: 250,
			cacheReadInputTokens: 40,
			cacheCreationInputTokens: 0,
		});
	});

	test('replaces (not accumulates) output_tokens across multiple message_delta events', async () => {
		// Anthropic occasionally emits more than one `message_delta` during long
		// generations or tool-use turns; each carries the latest cumulative
		// `output_tokens`. We must replace, not sum.
		const chunks = [
			sseEvent('message_start', {
				type: 'message_start',
				message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 1 } },
			}),
			sseEvent('message_delta', {
				type: 'message_delta',
				delta: { stop_reason: null },
				usage: { output_tokens: 100 },
			}),
			sseEvent('message_delta', {
				type: 'message_delta',
				delta: { stop_reason: 'end_turn' },
				usage: { output_tokens: 175 },
			}),
		];

		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(...chunks), s => { summary = s; })) {
			// consume
		}

		assert.deepStrictEqual(summary, {
			inputTokens: 10,
			outputTokens: 175,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});

	test('handles single chunk containing multiple SSE events', async () => {
		const combined =
			sseEvent('message_start', {
				type: 'message_start',
				message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 20, cache_read_input_tokens: 15 } },
			}) +
			sseEvent('message_delta', {
				type: 'message_delta',
				delta: { stop_reason: 'end_turn' },
				usage: { output_tokens: 8 },
			});

		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(combined), s => { summary = s; })) {
			// consume
		}

		assert.deepStrictEqual(summary, {
			inputTokens: 20,
			outputTokens: 8,
			cacheReadInputTokens: 15,
			cacheCreationInputTokens: 0,
		});
	});

	test('handles events split across chunk boundaries', async () => {
		const full = sseEvent('message_start', {
			type: 'message_start',
			message: { id: 'm1', model: 'claude-sonnet-4-6', usage: { input_tokens: 5, cache_creation_input_tokens: 3 } },
		});
		// Split arbitrarily in the middle of the SSE frame.
		const mid = Math.floor(full.length / 2);
		const part1 = full.slice(0, mid);
		const part2 = full.slice(mid);

		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(part1, part2), s => { summary = s; })) {
			// consume
		}

		assert.deepStrictEqual(summary, {
			inputTokens: 5,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 3,
		});
	});

	test('yields zero counts for non-Anthropic SSE (OpenAI format)', async () => {
		const openaiChunk =
			'data: {"id":"c1","choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n' +
			'data: [DONE]\n\n';

		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(openaiChunk), s => { summary = s; })) {
			// consume
		}

		assert.deepStrictEqual(summary, {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});

	test('calls onUsage exactly once even for empty stream', async () => {
		let callCount = 0;
		let summary: StreamUsageSummary | undefined;
		for await (const _ of passthroughCollectUsage(makeChunks(), s => { callCount++; summary = s; })) {
			// consume
		}

		assert.strictEqual(callCount, 1);
		assert.deepStrictEqual(summary, {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
		});
	});
});
