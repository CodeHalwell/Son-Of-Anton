// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

/**
 * Shared configuration constants for the MCP gateway.
 *
 * The vector size MUST match the indexer's `QDRANT_VECTOR_SIZE` env var
 * (see `services/indexer/src/config.ts`). The gateway embeds query vectors
 * against this dimension; if the two drift, Qdrant rejects every search.
 *
 * Default: 768 (matches the indexer's default and most standard code-search
 * embedding models). Override via `QDRANT_VECTOR_SIZE` for both services
 * together — never one without the other.
 */
export const QDRANT_VECTOR_SIZE = parseInt(
	process.env.QDRANT_VECTOR_SIZE ?? '768',
	10,
);

/**
 * Embedding configuration for query vectors.
 *
 * MUST match the indexer's embedding settings (`services/indexer/src/config.ts`
 * reads the same env vars): queries embedded with a different provider or
 * model than the stored documents score against noise. Compose wires both
 * services to the same variables.
 */
export const EMBEDDING_CONFIG = {
	provider: (process.env.EMBEDDING_PROVIDER ?? 'mock') as 'mock' | 'voyage' | 'openai' | 'local',
	model: process.env.EMBEDDING_MODEL || undefined,
	apiKey: process.env.EMBEDDING_API_KEY ?? process.env.VOYAGE_API_KEY ?? process.env.OPENAI_API_KEY,
	endpoint: process.env.EMBEDDING_ENDPOINT,
	maxRetries: parseInt(process.env.EMBEDDING_MAX_RETRIES ?? '3', 10),
};
