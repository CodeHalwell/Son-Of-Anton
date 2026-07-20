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

/** True for finite numbers only — excludes `undefined`, `NaN`, strings, `null`, etc. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Resolve the weights for a calling agent: exact handle match, then the
 * `"*"` catch-all, then the hard-coded default. Validates field-by-field
 * against `DEFAULT_RETRIEVAL_WEIGHTS` — config files are untyped JSON on
 * disk, so a missing, non-numeric, or malformed entry (e.g. only `semantic`
 * set, or `"structural": "high"`) must not silently turn the hybrid score
 * into `NaN`.
 */
export function resolveRetrievalWeights(
	config: RetrievalWeightsConfig,
	agentRole: string | undefined,
): RetrievalWeights {
	const resolved = (agentRole ? config[agentRole] : undefined) ?? config['*'];
	return {
		semantic: isFiniteNumber(resolved?.semantic) ? resolved.semantic : DEFAULT_RETRIEVAL_WEIGHTS.semantic,
		structural: isFiniteNumber(resolved?.structural) ? resolved.structural : DEFAULT_RETRIEVAL_WEIGHTS.structural,
	};
}
