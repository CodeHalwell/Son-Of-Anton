// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	MockEmbeddingProvider,
	VoyageEmbeddingProvider,
	OpenAICompatibleEmbeddingProvider,
	createEmbeddingProvider,
} from '../index';

function okResponse(vectors: number[][]): Response {
	return new Response(
		JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
	);
}

function fakeFetch(responses: Array<Response | Error>): { impl: typeof fetch; calls: Array<{ url: string; body: any }> } {
	const calls: Array<{ url: string; body: any }> = [];
	const impl = (async (url: any, init?: any) => {
		calls.push({ url: String(url), body: JSON.parse(init?.body ?? 'null') });
		const next = responses.shift();
		if (!next) {
			throw new Error('fakeFetch: no more responses queued');
		}
		if (next instanceof Error) {
			throw next;
		}
		return next;
	}) as typeof fetch;
	return { impl, calls };
}

describe('MockEmbeddingProvider', () => {
	test('produces deterministic unit vectors of the configured size', async () => {
		const provider = new MockEmbeddingProvider(64);
		const [a1] = await provider.embed(['hello']);
		const [a2] = await provider.embed(['hello']);
		const [b] = await provider.embed(['world']);

		const magnitude = Math.sqrt(a1.reduce((sum, v) => sum + v * v, 0));
		assert.deepStrictEqual(
			{
				dims: a1.length,
				deterministic: JSON.stringify(a1) === JSON.stringify(a2),
				distinct: JSON.stringify(a1) !== JSON.stringify(b),
				unit: Math.abs(magnitude - 1) < 1e-9,
				reported: provider.dimensions(),
			},
			{ dims: 64, deterministic: true, distinct: true, unit: true, reported: 64 }
		);
	});
});

describe('VoyageEmbeddingProvider', () => {
	test('sends model, input_type, and output_dimension with bearer auth', async () => {
		const { impl, calls } = fakeFetch([okResponse([[1, 0], [0, 1]])]);
		const provider = new VoyageEmbeddingProvider({
			provider: 'voyage',
			apiKey: 'vk-test',
			dimensions: 2,
			fetchImpl: impl,
		});

		const vectors = await provider.embed(['fn a', 'fn b'], 'query');

		assert.deepStrictEqual(
			{
				url: calls[0].url,
				body: calls[0].body,
				vectors,
			},
			{
				url: 'https://api.voyageai.com/v1/embeddings',
				body: { model: 'voyage-code-3', input: ['fn a', 'fn b'], input_type: 'query', output_dimension: 2 },
				vectors: [[1, 0], [0, 1]],
			}
		);
	});

	test('retries on 429 and 5xx, then succeeds', async () => {
		const { impl, calls } = fakeFetch([
			new Response('rate limited', { status: 429 }),
			new Response('boom', { status: 500 }),
			okResponse([[0.5, 0.5]]),
		]);
		const provider = new VoyageEmbeddingProvider({
			provider: 'voyage',
			apiKey: 'vk-test',
			dimensions: 2,
			maxRetries: 3,
			retryBaseDelayMs: 1,
			fetchImpl: impl,
		});

		const vectors = await provider.embed(['x']);
		assert.deepStrictEqual({ attempts: calls.length, vectors }, { attempts: 3, vectors: [[0.5, 0.5]] });
	});

	test('does not retry on 401 and surfaces the response body', async () => {
		const { impl, calls } = fakeFetch([new Response('invalid api key', { status: 401 })]);
		const provider = new VoyageEmbeddingProvider({
			provider: 'voyage',
			apiKey: 'vk-bad',
			dimensions: 2,
			retryBaseDelayMs: 1,
			fetchImpl: impl,
		});

		await assert.rejects(provider.embed(['x']), /401.*invalid api key/s);
		assert.equal(calls.length, 1);
	});

	test('rejects dimension mismatches with an actionable error', async () => {
		const { impl } = fakeFetch([okResponse([[1, 0, 0]])]);
		const provider = new VoyageEmbeddingProvider({
			provider: 'voyage',
			apiKey: 'vk-test',
			dimensions: 2,
			fetchImpl: impl,
		});

		await assert.rejects(provider.embed(['x']), /3-dimensional.*expects 2.*QDRANT_VECTOR_SIZE/s);
	});

	test('requires an API key, treating empty/whitespace strings as absent', () => {
		assert.throws(
			() => new VoyageEmbeddingProvider({ provider: 'voyage', dimensions: 2 }),
			/missing API key/
		);
		// Compose exports unset variables as empty strings — they must not
		// count as a configured key.
		assert.throws(
			() => new VoyageEmbeddingProvider({ provider: 'voyage', apiKey: '', dimensions: 2 }),
			/missing API key/
		);
		assert.throws(
			() => new VoyageEmbeddingProvider({ provider: 'voyage', apiKey: '   ', dimensions: 2 }),
			/missing API key/
		);
	});

	test('empty endpoint and model fall back to provider defaults', async () => {
		const { impl, calls } = fakeFetch([okResponse([[1, 0]])]);
		const provider = new VoyageEmbeddingProvider({
			provider: 'voyage',
			apiKey: 'vk-test',
			endpoint: '',
			model: '',
			dimensions: 2,
			fetchImpl: impl,
		});

		await provider.embed(['x']);
		assert.deepStrictEqual(
			{ url: calls[0].url, model: calls[0].body.model },
			{ url: 'https://api.voyageai.com/v1/embeddings', model: 'voyage-code-3' }
		);
	});

	test('a NaN maxRetries (e.g. EMBEDDING_MAX_RETRIES="") still retries with the default', async () => {
		const { impl, calls } = fakeFetch([
			new Response('boom', { status: 500 }),
			okResponse([[1, 0]]),
		]);
		const provider = new VoyageEmbeddingProvider({
			provider: 'voyage',
			apiKey: 'vk-test',
			dimensions: 2,
			maxRetries: Number.NaN,
			retryBaseDelayMs: 1,
			fetchImpl: impl,
		});

		const vectors = await provider.embed(['x']);
		assert.deepStrictEqual({ attempts: calls.length, vectors }, { attempts: 2, vectors: [[1, 0]] });
	});
});

describe('OpenAICompatibleEmbeddingProvider', () => {
	test('openai sends dimensions and defaults model + endpoint', async () => {
		const { impl, calls } = fakeFetch([okResponse([[1, 0]])]);
		const provider = new OpenAICompatibleEmbeddingProvider({
			provider: 'openai',
			apiKey: 'sk-test',
			dimensions: 2,
			fetchImpl: impl,
		});

		await provider.embed(['x']);
		assert.deepStrictEqual(
			{ url: calls[0].url, body: calls[0].body },
			{
				url: 'https://api.openai.com/v1/embeddings',
				body: { model: 'text-embedding-3-small', input: ['x'], encoding_format: 'float', dimensions: 2 },
			}
		);
	});

	test('local omits dimensions, allows keyless endpoints, requires model + endpoint', async () => {
		const { impl, calls } = fakeFetch([okResponse([[1, 0]])]);
		const provider = new OpenAICompatibleEmbeddingProvider({
			provider: 'local',
			endpoint: 'http://localhost:11434/v1/embeddings',
			model: 'nomic-embed-text',
			dimensions: 2,
			fetchImpl: impl,
		});

		await provider.embed(['x']);
		assert.deepStrictEqual(
			{ url: calls[0].url, body: calls[0].body },
			{
				url: 'http://localhost:11434/v1/embeddings',
				body: { model: 'nomic-embed-text', input: ['x'], encoding_format: 'float' },
			}
		);

		assert.throws(
			() => new OpenAICompatibleEmbeddingProvider({ provider: 'local', model: 'm', dimensions: 2 }),
			/missing endpoint/
		);
		assert.throws(
			() => new OpenAICompatibleEmbeddingProvider({ provider: 'local', endpoint: 'http://x/v1/embeddings', dimensions: 2 }),
			/missing model/
		);
	});

	test('retries network errors', async () => {
		const { impl, calls } = fakeFetch([new Error('ECONNREFUSED'), okResponse([[1, 0]])]);
		const provider = new OpenAICompatibleEmbeddingProvider({
			provider: 'local',
			endpoint: 'http://localhost:8085/v1/embeddings',
			model: 'test-model',
			dimensions: 2,
			maxRetries: 2,
			retryBaseDelayMs: 1,
			fetchImpl: impl,
		});

		const vectors = await provider.embed(['x']);
		assert.deepStrictEqual({ attempts: calls.length, vectors }, { attempts: 2, vectors: [[1, 0]] });
	});
});

describe('createEmbeddingProvider', () => {
	test('maps provider kinds to implementations and rejects unknown kinds', () => {
		assert.deepStrictEqual(
			{
				mock: createEmbeddingProvider({ provider: 'mock', dimensions: 8 }).name,
				voyage: createEmbeddingProvider({ provider: 'voyage', apiKey: 'k', dimensions: 8 }).name,
				openai: createEmbeddingProvider({ provider: 'openai', apiKey: 'k', dimensions: 8 }).name,
				local: createEmbeddingProvider({
					provider: 'local', endpoint: 'http://x/v1/embeddings', model: 'm', dimensions: 8,
				}).name,
			},
			{ mock: 'mock', voyage: 'voyage', openai: 'openai', local: 'local' }
		);

		assert.throws(
			() => createEmbeddingProvider({ provider: 'nope' as never, dimensions: 8 }),
			/Unknown embedding provider/
		);
	});

	test('empty input returns empty output without a network call', async () => {
		const { impl, calls } = fakeFetch([]);
		const provider = createEmbeddingProvider({
			provider: 'voyage', apiKey: 'k', dimensions: 2, fetchImpl: impl,
		});
		assert.deepStrictEqual({ vectors: await provider.embed([]), calls: calls.length }, { vectors: [], calls: 0 });
	});
});
