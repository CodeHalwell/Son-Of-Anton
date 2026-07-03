// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

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

import crypto from 'crypto';

/**
 * Whether the text being embedded is indexed content or a search query.
 * Providers that support asymmetric embedding (Voyage) use this to pick the
 * right encoding side; symmetric providers ignore it.
 */
export type EmbeddingInputType = 'document' | 'query';

/** Embedding provider interface — allows swapping models. */
export interface EmbeddingProvider {
	/** Short provider identifier for logs and error messages. */
	readonly name: string;
	embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
	dimensions(): number;
}

export type EmbeddingProviderKind = 'mock' | 'voyage' | 'openai' | 'local';

export interface EmbeddingProviderOptions {
	provider: EmbeddingProviderKind;
	/**
	 * Model name. Defaults per provider: voyage → `voyage-code-3`,
	 * openai → `text-embedding-3-small`. Required for `local`.
	 */
	model?: string;
	/**
	 * Expected vector dimensionality. MUST match the Qdrant collection's
	 * vector size (`QDRANT_VECTOR_SIZE`). Providers validate every response
	 * against this and fail loudly on mismatch.
	 */
	dimensions: number;
	/** API key. Required for voyage and openai; optional for local endpoints. */
	apiKey?: string;
	/** Full embeddings endpoint URL. Required for `local`; defaulted otherwise. */
	endpoint?: string;
	/** Max retries per request on 429/5xx/network errors. Default 3. */
	maxRetries?: number;
	/** Base backoff delay in ms (doubles per attempt). Default 500. */
	retryBaseDelayMs?: number;
	/** Injectable fetch for tests. Defaults to global fetch. */
	fetchImpl?: typeof fetch;
}

/**
 * Mock embedding provider for development and testing.
 * Generates deterministic pseudo-random vectors based on content hash.
 *
 * The exact math is load-bearing: collections indexed with this mock must
 * remain searchable by queries embedded with it, so any change here
 * invalidates existing dev indexes.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'mock';
	private readonly vectorSize: number;

	constructor(vectorSize: number = 768) {
		this.vectorSize = vectorSize;
	}

	async embed(texts: string[]): Promise<number[][]> {
		return texts.map(text => {
			const hash = crypto.createHash('sha256').update(text).digest();
			const vector: number[] = [];
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

	dimensions(): number {
		return this.vectorSize;
	}
}

interface HttpRequestContext {
	providerName: string;
	url: string;
	headers: Record<string, string>;
	maxRetries: number;
	retryBaseDelayMs: number;
	fetchImpl: typeof fetch;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST a JSON body with exponential-backoff retry on 429, 5xx, and network
 * errors. 4xx (other than 429) fails immediately — retrying a bad request or
 * bad key just burns quota.
 */
async function postJsonWithRetry(ctx: HttpRequestContext, body: unknown): Promise<unknown> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= ctx.maxRetries; attempt++) {
		if (attempt > 0) {
			await sleep(ctx.retryBaseDelayMs * 2 ** (attempt - 1));
		}
		let response: Response;
		try {
			response = await ctx.fetchImpl(ctx.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...ctx.headers },
				body: JSON.stringify(body),
			});
		} catch (err) {
			lastError = new Error(`[${ctx.providerName}] network error calling ${ctx.url}: ${(err as Error).message}`);
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

/** Shape shared by Voyage and OpenAI embeddings responses. */
interface EmbeddingsApiResponse {
	data?: Array<{ index?: number; embedding?: number[] }>;
}

function extractVectors(
	providerName: string,
	raw: unknown,
	expectedCount: number,
	expectedDimensions: number
): number[][] {
	const response = raw as EmbeddingsApiResponse;
	if (!Array.isArray(response?.data)) {
		throw new Error(`[${providerName}] malformed embeddings response: missing data array`);
	}
	if (response.data.length !== expectedCount) {
		throw new Error(
			`[${providerName}] embeddings response has ${response.data.length} vectors, expected ${expectedCount}`
		);
	}
	// APIs document in-order responses but also carry an index field; honour it.
	const ordered = [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	return ordered.map((entry, i) => {
		const vector = entry.embedding;
		if (!Array.isArray(vector)) {
			throw new Error(`[${providerName}] malformed embeddings response: entry ${i} has no embedding`);
		}
		if (vector.length !== expectedDimensions) {
			throw new Error(
				`[${providerName}] model returned ${vector.length}-dimensional vectors but the Qdrant collection ` +
				`expects ${expectedDimensions}. Align QDRANT_VECTOR_SIZE with the model's output dimension ` +
				`(and re-index) — mismatched dimensions make every search fail.`
			);
		}
		return vector;
	});
}

/**
 * Voyage AI embedding provider. Supports asymmetric document/query encoding
 * and configurable output dimension (voyage-code-3: 256, 512, 1024, 2048).
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
	readonly name = 'voyage';
	private readonly ctx: HttpRequestContext;
	private readonly model: string;
	private readonly vectorSize: number;

	constructor(options: EmbeddingProviderOptions) {
		if (!options.apiKey) {
			throw new Error(
				'[voyage] missing API key. Set EMBEDDING_API_KEY (or VOYAGE_API_KEY) or switch EMBEDDING_PROVIDER.'
			);
		}
		this.model = options.model ?? 'voyage-code-3';
		this.vectorSize = options.dimensions;
		this.ctx = {
			providerName: this.name,
			url: options.endpoint ?? 'https://api.voyageai.com/v1/embeddings',
			headers: { Authorization: `Bearer ${options.apiKey}` },
			maxRetries: options.maxRetries ?? 3,
			retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
			fetchImpl: options.fetchImpl ?? fetch,
		};
	}

	async embed(texts: string[], inputType: EmbeddingInputType = 'document'): Promise<number[][]> {
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

	dimensions(): number {
		return this.vectorSize;
	}
}

/**
 * OpenAI-compatible embedding provider. Covers both the hosted OpenAI API
 * (`openai`) and self-hosted OpenAI-compatible endpoints (`local`: Ollama,
 * text-embeddings-inference, LM Studio, vLLM, …).
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
	readonly name: string;
	private readonly ctx: HttpRequestContext;
	private readonly model: string;
	private readonly vectorSize: number;
	private readonly sendDimensions: boolean;

	constructor(options: EmbeddingProviderOptions) {
		this.name = options.provider;
		if (options.provider === 'openai' && !options.apiKey) {
			throw new Error(
				'[openai] missing API key. Set EMBEDDING_API_KEY (or OPENAI_API_KEY) or switch EMBEDDING_PROVIDER.'
			);
		}
		if (options.provider === 'local' && !options.endpoint) {
			throw new Error(
				'[local] missing endpoint. Set EMBEDDING_ENDPOINT to a full OpenAI-compatible embeddings URL ' +
				'(e.g. http://localhost:11434/v1/embeddings for Ollama).'
			);
		}
		if (options.provider === 'local' && !options.model) {
			throw new Error('[local] missing model. Set EMBEDDING_MODEL to the model served at EMBEDDING_ENDPOINT.');
		}
		this.model = options.model ?? 'text-embedding-3-small';
		this.vectorSize = options.dimensions;
		// Hosted OpenAI supports Matryoshka truncation via `dimensions`; many
		// local servers reject unknown fields, so only send it to OpenAI.
		this.sendDimensions = options.provider === 'openai';
		this.ctx = {
			providerName: this.name,
			url: options.endpoint ?? 'https://api.openai.com/v1/embeddings',
			headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
			maxRetries: options.maxRetries ?? 3,
			retryBaseDelayMs: options.retryBaseDelayMs ?? 500,
			fetchImpl: options.fetchImpl ?? fetch,
		};
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}
		const body: Record<string, unknown> = {
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

	dimensions(): number {
		return this.vectorSize;
	}
}

/**
 * Create an embedding provider from configuration. Throws on misconfiguration
 * (missing key/endpoint/model) rather than silently degrading — a service
 * explicitly configured for real embeddings must not quietly index noise.
 */
export function createEmbeddingProvider(options: EmbeddingProviderOptions): EmbeddingProvider {
	switch (options.provider) {
		case 'mock':
			return new MockEmbeddingProvider(options.dimensions);
		case 'voyage':
			return new VoyageEmbeddingProvider(options);
		case 'openai':
		case 'local':
			return new OpenAICompatibleEmbeddingProvider(options);
		default:
			throw new Error(
				`Unknown embedding provider "${options.provider}". Valid values: mock, voyage, openai, local.`
			);
	}
}
