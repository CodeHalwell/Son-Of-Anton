"use strict";
// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const index_1 = require("../index");
function okResponse(vectors) {
    return new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
function fakeFetch(responses) {
    const calls = [];
    const impl = (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init?.body ?? 'null') });
        const next = responses.shift();
        if (!next) {
            throw new Error('fakeFetch: no more responses queued');
        }
        if (next instanceof Error) {
            throw next;
        }
        return next;
    });
    return { impl, calls };
}
(0, node_test_1.describe)('MockEmbeddingProvider', () => {
    (0, node_test_1.test)('produces deterministic unit vectors of the configured size', async () => {
        const provider = new index_1.MockEmbeddingProvider(64);
        const [a1] = await provider.embed(['hello']);
        const [a2] = await provider.embed(['hello']);
        const [b] = await provider.embed(['world']);
        const magnitude = Math.sqrt(a1.reduce((sum, v) => sum + v * v, 0));
        strict_1.default.deepStrictEqual({
            dims: a1.length,
            deterministic: JSON.stringify(a1) === JSON.stringify(a2),
            distinct: JSON.stringify(a1) !== JSON.stringify(b),
            unit: Math.abs(magnitude - 1) < 1e-9,
            reported: provider.dimensions(),
        }, { dims: 64, deterministic: true, distinct: true, unit: true, reported: 64 });
    });
});
(0, node_test_1.describe)('VoyageEmbeddingProvider', () => {
    (0, node_test_1.test)('sends model, input_type, and output_dimension with bearer auth', async () => {
        const { impl, calls } = fakeFetch([okResponse([[1, 0], [0, 1]])]);
        const provider = new index_1.VoyageEmbeddingProvider({
            provider: 'voyage',
            apiKey: 'vk-test',
            dimensions: 2,
            fetchImpl: impl,
        });
        const vectors = await provider.embed(['fn a', 'fn b'], 'query');
        strict_1.default.deepStrictEqual({
            url: calls[0].url,
            body: calls[0].body,
            vectors,
        }, {
            url: 'https://api.voyageai.com/v1/embeddings',
            body: { model: 'voyage-code-3', input: ['fn a', 'fn b'], input_type: 'query', output_dimension: 2 },
            vectors: [[1, 0], [0, 1]],
        });
    });
    (0, node_test_1.test)('retries on 429 and 5xx, then succeeds', async () => {
        const { impl, calls } = fakeFetch([
            new Response('rate limited', { status: 429 }),
            new Response('boom', { status: 500 }),
            okResponse([[0.5, 0.5]]),
        ]);
        const provider = new index_1.VoyageEmbeddingProvider({
            provider: 'voyage',
            apiKey: 'vk-test',
            dimensions: 2,
            maxRetries: 3,
            retryBaseDelayMs: 1,
            fetchImpl: impl,
        });
        const vectors = await provider.embed(['x']);
        strict_1.default.deepStrictEqual({ attempts: calls.length, vectors }, { attempts: 3, vectors: [[0.5, 0.5]] });
    });
    (0, node_test_1.test)('does not retry on 401 and surfaces the response body', async () => {
        const { impl, calls } = fakeFetch([new Response('invalid api key', { status: 401 })]);
        const provider = new index_1.VoyageEmbeddingProvider({
            provider: 'voyage',
            apiKey: 'vk-bad',
            dimensions: 2,
            retryBaseDelayMs: 1,
            fetchImpl: impl,
        });
        await strict_1.default.rejects(provider.embed(['x']), /401.*invalid api key/s);
        strict_1.default.equal(calls.length, 1);
    });
    (0, node_test_1.test)('rejects dimension mismatches with an actionable error', async () => {
        const { impl } = fakeFetch([okResponse([[1, 0, 0]])]);
        const provider = new index_1.VoyageEmbeddingProvider({
            provider: 'voyage',
            apiKey: 'vk-test',
            dimensions: 2,
            fetchImpl: impl,
        });
        await strict_1.default.rejects(provider.embed(['x']), /3-dimensional.*expects 2.*QDRANT_VECTOR_SIZE/s);
    });
    (0, node_test_1.test)('requires an API key', () => {
        strict_1.default.throws(() => new index_1.VoyageEmbeddingProvider({ provider: 'voyage', dimensions: 2 }), /missing API key/);
    });
});
(0, node_test_1.describe)('OpenAICompatibleEmbeddingProvider', () => {
    (0, node_test_1.test)('openai sends dimensions and defaults model + endpoint', async () => {
        const { impl, calls } = fakeFetch([okResponse([[1, 0]])]);
        const provider = new index_1.OpenAICompatibleEmbeddingProvider({
            provider: 'openai',
            apiKey: 'sk-test',
            dimensions: 2,
            fetchImpl: impl,
        });
        await provider.embed(['x']);
        strict_1.default.deepStrictEqual({ url: calls[0].url, body: calls[0].body }, {
            url: 'https://api.openai.com/v1/embeddings',
            body: { model: 'text-embedding-3-small', input: ['x'], encoding_format: 'float', dimensions: 2 },
        });
    });
    (0, node_test_1.test)('local omits dimensions, allows keyless endpoints, requires model + endpoint', async () => {
        const { impl, calls } = fakeFetch([okResponse([[1, 0]])]);
        const provider = new index_1.OpenAICompatibleEmbeddingProvider({
            provider: 'local',
            endpoint: 'http://localhost:11434/v1/embeddings',
            model: 'nomic-embed-text',
            dimensions: 2,
            fetchImpl: impl,
        });
        await provider.embed(['x']);
        strict_1.default.deepStrictEqual({ url: calls[0].url, body: calls[0].body }, {
            url: 'http://localhost:11434/v1/embeddings',
            body: { model: 'nomic-embed-text', input: ['x'], encoding_format: 'float' },
        });
        strict_1.default.throws(() => new index_1.OpenAICompatibleEmbeddingProvider({ provider: 'local', model: 'm', dimensions: 2 }), /missing endpoint/);
        strict_1.default.throws(() => new index_1.OpenAICompatibleEmbeddingProvider({ provider: 'local', endpoint: 'http://x/v1/embeddings', dimensions: 2 }), /missing model/);
    });
    (0, node_test_1.test)('retries network errors', async () => {
        const { impl, calls } = fakeFetch([new Error('ECONNREFUSED'), okResponse([[1, 0]])]);
        const provider = new index_1.OpenAICompatibleEmbeddingProvider({
            provider: 'local',
            endpoint: 'http://localhost:8085/v1/embeddings',
            model: 'test-model',
            dimensions: 2,
            maxRetries: 2,
            retryBaseDelayMs: 1,
            fetchImpl: impl,
        });
        const vectors = await provider.embed(['x']);
        strict_1.default.deepStrictEqual({ attempts: calls.length, vectors }, { attempts: 2, vectors: [[1, 0]] });
    });
});
(0, node_test_1.describe)('createEmbeddingProvider', () => {
    (0, node_test_1.test)('maps provider kinds to implementations and rejects unknown kinds', () => {
        strict_1.default.deepStrictEqual({
            mock: (0, index_1.createEmbeddingProvider)({ provider: 'mock', dimensions: 8 }).name,
            voyage: (0, index_1.createEmbeddingProvider)({ provider: 'voyage', apiKey: 'k', dimensions: 8 }).name,
            openai: (0, index_1.createEmbeddingProvider)({ provider: 'openai', apiKey: 'k', dimensions: 8 }).name,
            local: (0, index_1.createEmbeddingProvider)({
                provider: 'local', endpoint: 'http://x/v1/embeddings', model: 'm', dimensions: 8,
            }).name,
        }, { mock: 'mock', voyage: 'voyage', openai: 'openai', local: 'local' });
        strict_1.default.throws(() => (0, index_1.createEmbeddingProvider)({ provider: 'nope', dimensions: 8 }), /Unknown embedding provider/);
    });
    (0, node_test_1.test)('empty input returns empty output without a network call', async () => {
        const { impl, calls } = fakeFetch([]);
        const provider = (0, index_1.createEmbeddingProvider)({
            provider: 'voyage', apiKey: 'k', dimensions: 2, fetchImpl: impl,
        });
        strict_1.default.deepStrictEqual({ vectors: await provider.embed([]), calls: calls.length }, { vectors: [], calls: 0 });
    });
});
//# sourceMappingURL=embeddings.test.js.map