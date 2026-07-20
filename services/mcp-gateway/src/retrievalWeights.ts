// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-agent hybrid retrieval scoring weights for `semantic_search` (F-3).
 *
 * `semantic` weights the vector-similarity score from Qdrant; `structural`
 * weights the graph in-degree signal from FalkorDB. Both are combined as
 * `semantic * result.score + structural * structuralImportance` in
 * `tools/semanticSearch.ts`. The two need not sum to 1 — callers who want a
 * signal to dominate can push either above its default share.
 */
export interface RetrievalWeights {
	readonly semantic: number;
	readonly structural: number;
}

/**
 * Schema for `.son-of-anton/retrieval-weights.json`.
 *
 * Keys are agent handles (e.g. "anton", "anton-code", "anton-review" — see
 * `AgentHandle` in `son-of-anton-core/src/agents/types.ts`) or "*" as a
 * catch-all, mirroring the role-keyed shape of `.son-of-anton/routing.json`
 * (`services/model-router/src/failover/types.ts`).
 *
 * Example:
 * ```jsonc
 * {
 *   "anton-review": { "semantic": 0.6, "structural": 0.4 },
 *   "*": { "semantic": 0.8, "structural": 0.2 }
 * }
 * ```
 */
export type RetrievalWeightsConfig = Record<string, RetrievalWeights>;

/** Weights matching the hybrid score's historical, unconfigured behaviour. */
export const DEFAULT_RETRIEVAL_WEIGHTS: RetrievalWeights = { semantic: 0.8, structural: 0.2 };

export function loadRetrievalWeightsConfig(): RetrievalWeightsConfig {
	const explicitPath = process.env.RETRIEVAL_WEIGHTS_CONFIG;
	const candidates = [
		explicitPath,
		join(process.cwd(), '.son-of-anton', 'retrieval-weights.json'),
		join(process.cwd(), '..', '..', '.son-of-anton', 'retrieval-weights.json'),
	].filter((path): path is string => typeof path === 'string');

	for (const path of candidates) {
		if (existsSync(path)) {
			try {
				return JSON.parse(readFileSync(path, 'utf-8')) as RetrievalWeightsConfig;
			} catch (err) {
				if (path === explicitPath) {
					// Explicit path must be readable — surface this loudly.
					console.error(`[retrieval-weights] Failed to parse explicit config at ${path}:`, (err as Error).message);
				} else {
					console.warn(`[retrieval-weights] Skipping unreadable config at ${path}:`, (err as Error).message);
				}
			}
		}
	}
	return {};
}

/**
 * Resolve the weights for a calling agent: exact handle match, then the
 * `"*"` catch-all, then the hard-coded default.
 */
export function resolveRetrievalWeights(
	config: RetrievalWeightsConfig,
	agentRole: string | undefined,
): RetrievalWeights {
	return (agentRole ? config[agentRole] : undefined) ?? config['*'] ?? DEFAULT_RETRIEVAL_WEIGHTS;
}
