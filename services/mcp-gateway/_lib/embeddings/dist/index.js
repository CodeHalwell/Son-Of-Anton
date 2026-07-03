"use strict";
// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAICompatibleEmbeddingProvider = exports.VoyageEmbeddingProvider = exports.MockEmbeddingProvider = void 0;
exports.createEmbeddingProvider = createEmbeddingProvider;
/**
 * Shared embedding providers for Son of Anton backend services.
 *
 * The indexer embeds code chunks ("documents") and the mcp-gateway embeds
 * search queries. Both MUST use the same provider, model, and dimensionality
 * or Qdrant similarity scores are meaningless — vendoring this single module
 * into both services is how that invariant is kept.
 *
 * Providers:
 *  - `mock`   — deterministic SHA-256 pseudo-vectors. No network. Dev/test only.
 *  - `voyage` — Voyage AI (`voyage-code-3` by default), purpose-built for code.
 *  - `openai` — OpenAI embeddings API (`text-embedding-3-small` by default).
 *  - `local`  — any OpenAI-compatible endpoint (Ollama, TEI, LM Studio, vLLM).
 */
const crypto_1 = __importDefault(require("crypto"));
/**
 * Treat empty/whitespace strings as absent. Compose exports unset variables
 * as empty strings (`${EMBEDDING_API_KEY:-}`), which must not shadow
 * documented fallbacks or become bogus endpoint URLs.
 */
function nonEmpty(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
/** Clamp a possibly-NaN/negative retry count to a sane non-negative integer. */
function normalisedRetries(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : fallback;
}
/**
 * Mock embedding provider for development and testing.
 * Generates deterministic pseudo-random vectors based on content hash.
 *
 * The exact math is load-bearing: collections indexed with this mock must
 * remain searchable by queries embedded with it, so any change here
 * invalidates existing dev indexes.
 */
class MockEmbeddingProvider {
    name = 'mock';
    vectorSize;
    constructor(vectorSize = 768) {
        this.vectorSize = vectorSize;
    }
    async embed(texts) {
        return texts.map(text => {
            const hash = crypto_1.default.createHash('sha256').update(text).digest();
            const vector = [];
            for (let i = 0; i < this.vectorSize; i++) {
                // Deterministic pseudo-random value in [-1, 1] based on content
                const byteIdx = i % hash.length;
                vector.push((hash[byteIdx] / 128.0) - 1.0);
            }
            // Normalize to unit vector
            const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
            return vector.map(v => v / magnitude);
        });
    }
    dimensions() {
        return this.vectorSize;
    }
}
exports.MockEmbeddingProvider = MockEmbeddingProvider;
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * POST a JSON body with exponential-backoff retry on 429, 5xx, and network
 * errors. 4xx (other than 429) fails immediately — retrying a bad request or
 * bad key just burns quota.
 */
async function postJsonWithRetry(ctx, body) {
    let lastError;
    for (let attempt = 0; attempt <= ctx.maxRetries; attempt++) {
        if (attempt > 0) {
            await sleep(ctx.retryBaseDelayMs * 2 ** (attempt - 1));
        }
        let response;
        try {
            response = await ctx.fetchImpl(ctx.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...ctx.headers },
                body: JSON.stringify(body),
            });
        }
        catch (err) {
            lastError = new Error(`[${ctx.providerName}] network error calling ${ctx.url}: ${err.message}`);
            continue;
        }
        if (response.ok) {
            return response.json();
        }
        const detail = await response.text().catch(() => '');
        const message = `[${ctx.providerName}] ${ctx.url} returned ${response.status}: ${detail.slice(0, 500)}`;
        if (response.status === 429 || response.status >= 500) {
            lastError = new Error(message);
            continue;
        }
        throw new Error(message);
    }
    throw lastError ?? new Error(`[${ctx.providerName}] request failed`);
}
function extractVectors(providerName, raw, expectedCount, expectedDimensions) {
    const response = raw;
    if (!Array.isArray(response?.data)) {
        throw new Error(`[${providerName}] malformed embeddings response: missing data array`);
    }
    if (response.data.length !== expectedCount) {
        throw new Error(`[${providerName}] embeddings response has ${response.data.length} vectors, expected ${expectedCount}`);
    }
    // APIs document in-order responses but also carry an index field; honour it.
    const ordered = [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return ordered.map((entry, i) => {
        const vector = entry.embedding;
        if (!Array.isArray(vector)) {
            throw new Error(`[${providerName}] malformed embeddings response: entry ${i} has no embedding`);
        }
        if (vector.length !== expectedDimensions) {
            throw new Error(`[${providerName}] model returned ${vector.length}-dimensional vectors but the Qdrant collection ` +
                `expects ${expectedDimensions}. Align QDRANT_VECTOR_SIZE with the model's output dimension ` +
                `(and re-index) — mismatched dimensions make every search fail.`);
        }
        return vector;
    });
}
/**
 * Voyage AI embedding provider. Supports asymmetric document/query encoding
 * and configurable output dimension (voyage-code-3: 256, 512, 1024, 2048).
 */
class VoyageEmbeddingProvider {
    name = 'voyage';
    ctx;
    model;
    vectorSize;
    constructor(options) {
        const apiKey = nonEmpty(options.apiKey);
        if (!apiKey) {
            throw new Error('[voyage] missing API key. Set EMBEDDING_API_KEY (or VOYAGE_API_KEY) or switch EMBEDDING_PROVIDER.');
        }
        this.model = nonEmpty(options.model) ?? 'voyage-code-3';
        this.vectorSize = options.dimensions;
        this.ctx = {
            providerName: this.name,
            url: nonEmpty(options.endpoint) ?? 'https://api.voyageai.com/v1/embeddings',
            headers: { Authorization: `Bearer ${apiKey}` },
            maxRetries: normalisedRetries(options.maxRetries, 3),
            retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
            fetchImpl: options.fetchImpl ?? fetch,
        };
    }
    async embed(texts, inputType = 'document') {
        if (texts.length === 0) {
            return [];
        }
        const raw = await postJsonWithRetry(this.ctx, {
            model: this.model,
            input: texts,
            input_type: inputType,
            output_dimension: this.vectorSize,
        });
        return extractVectors(this.name, raw, texts.length, this.vectorSize);
    }
    dimensions() {
        return this.vectorSize;
    }
}
exports.VoyageEmbeddingProvider = VoyageEmbeddingProvider;
/**
 * OpenAI-compatible embedding provider. Covers both the hosted OpenAI API
 * (`openai`) and self-hosted OpenAI-compatible endpoints (`local`: Ollama,
 * text-embeddings-inference, LM Studio, vLLM, …).
 */
class OpenAICompatibleEmbeddingProvider {
    name;
    ctx;
    model;
    vectorSize;
    sendDimensions;
    constructor(options) {
        this.name = options.provider;
        const apiKey = nonEmpty(options.apiKey);
        const endpoint = nonEmpty(options.endpoint);
        const model = nonEmpty(options.model);
        if (options.provider === 'openai' && !apiKey) {
            throw new Error('[openai] missing API key. Set EMBEDDING_API_KEY (or OPENAI_API_KEY) or switch EMBEDDING_PROVIDER.');
        }
        if (options.provider === 'local' && !endpoint) {
            throw new Error('[local] missing endpoint. Set EMBEDDING_ENDPOINT to a full OpenAI-compatible embeddings URL ' +
                '(e.g. http://localhost:11434/v1/embeddings for Ollama).');
        }
        if (options.provider === 'local' && !model) {
            throw new Error('[local] missing model. Set EMBEDDING_MODEL to the model served at EMBEDDING_ENDPOINT.');
        }
        this.model = model ?? 'text-embedding-3-small';
        this.vectorSize = options.dimensions;
        // Hosted OpenAI supports Matryoshka truncation via `dimensions`; many
        // local servers reject unknown fields, so only send it to OpenAI.
        this.sendDimensions = options.provider === 'openai';
        this.ctx = {
            providerName: this.name,
            url: endpoint ?? 'https://api.openai.com/v1/embeddings',
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            maxRetries: normalisedRetries(options.maxRetries, 3),
            retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
            fetchImpl: options.fetchImpl ?? fetch,
        };
    }
    async embed(texts) {
        if (texts.length === 0) {
            return [];
        }
        const body = {
            model: this.model,
            input: texts,
            encoding_format: 'float',
        };
        if (this.sendDimensions) {
            body.dimensions = this.vectorSize;
        }
        const raw = await postJsonWithRetry(this.ctx, body);
        return extractVectors(this.name, raw, texts.length, this.vectorSize);
    }
    dimensions() {
        return this.vectorSize;
    }
}
exports.OpenAICompatibleEmbeddingProvider = OpenAICompatibleEmbeddingProvider;
/**
 * Create an embedding provider from configuration. Throws on misconfiguration
 * (missing key/endpoint/model) rather than silently degrading — a service
 * explicitly configured for real embeddings must not quietly index noise.
 */
function createEmbeddingProvider(options) {
    switch (options.provider) {
        case 'mock':
            return new MockEmbeddingProvider(options.dimensions);
        case 'voyage':
            return new VoyageEmbeddingProvider(options);
        case 'openai':
        case 'local':
            return new OpenAICompatibleEmbeddingProvider(options);
        default:
            throw new Error(`Unknown embedding provider "${options.provider}". Valid values: mock, voyage, openai, local.`);
    }
}
//# sourceMappingURL=index.js.map