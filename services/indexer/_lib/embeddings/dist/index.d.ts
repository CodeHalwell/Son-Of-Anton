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
export declare class MockEmbeddingProvider implements EmbeddingProvider {
    readonly name = "mock";
    private readonly vectorSize;
    constructor(vectorSize?: number);
    embed(texts: string[]): Promise<number[][]>;
    dimensions(): number;
}
/**
 * Voyage AI embedding provider. Supports asymmetric document/query encoding
 * and configurable output dimension (voyage-code-3: 256, 512, 1024, 2048).
 */
export declare class VoyageEmbeddingProvider implements EmbeddingProvider {
    readonly name = "voyage";
    private readonly ctx;
    private readonly model;
    private readonly vectorSize;
    constructor(options: EmbeddingProviderOptions);
    embed(texts: string[], inputType?: EmbeddingInputType): Promise<number[][]>;
    dimensions(): number;
}
/**
 * OpenAI-compatible embedding provider. Covers both the hosted OpenAI API
 * (`openai`) and self-hosted OpenAI-compatible endpoints (`local`: Ollama,
 * text-embeddings-inference, LM Studio, vLLM, …).
 */
export declare class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
    readonly name: string;
    private readonly ctx;
    private readonly model;
    private readonly vectorSize;
    private readonly sendDimensions;
    constructor(options: EmbeddingProviderOptions);
    embed(texts: string[]): Promise<number[][]>;
    dimensions(): number;
}
/**
 * Create an embedding provider from configuration. Throws on misconfiguration
 * (missing key/endpoint/model) rather than silently degrading — a service
 * explicitly configured for real embeddings must not quietly index noise.
 */
export declare function createEmbeddingProvider(options: EmbeddingProviderOptions): EmbeddingProvider;
