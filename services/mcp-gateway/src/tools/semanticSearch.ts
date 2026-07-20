// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

import { FalkorDBClient } from '../clients/falkordb';
import { QdrantClient, SemanticSearchResult } from '../clients/qdrant';
import { DEFAULT_RETRIEVAL_WEIGHTS, RetrievalWeights } from '../retrievalWeights';

export interface SemanticSearchInput {
	query: string;
	maxResults?: number;
	language?: string;
}

export interface RankedSearchResult extends SemanticSearchResult {
	relevanceScore: number;
	structuralImportance: number;
}

export async function semanticSearch(
	qdrant: QdrantClient,
	db: FalkorDBClient,
	input: SemanticSearchInput,
	embedQuery: (text: string) => Promise<number[]>,
	weights: RetrievalWeights = DEFAULT_RETRIEVAL_WEIGHTS
): Promise<RankedSearchResult[]> {
	const maxResults = Math.min(input.maxResults ?? 10, 50);

	const queryVector = await embedQuery(input.query);

	const filter = input.language
		? {
			must: [{ key: 'language', match: { value: input.language } }],
		}
		: undefined;

	// Candidate pool is sized off semantic similarity alone, so a
	// structural-heavy `weights` (F-3) can only re-rank within this window —
	// a highly-referenced symbol Qdrant didn't surface here is never a
	// candidate, regardless of configured structural weight. Broadening the
	// pool with graph-selected candidates is tracked as F-29.
	const results = await qdrant.search(queryVector, maxResults * 2, filter);

	// Fetch structural importance scores from FalkorDB
	const rankedResults = await addStructuralScores(db, results, weights);

	// Sort by combined score (semantic similarity + structural importance)
	rankedResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

	return rankedResults.slice(0, maxResults);
}

async function addStructuralScores(
	db: FalkorDBClient,
	results: SemanticSearchResult[],
	weights: RetrievalWeights
): Promise<RankedSearchResult[]> {
	const ranked: RankedSearchResult[] = [];

	// Build a list of unique (symbolName, filePath) pairs to look up in a single query.
	type SymbolKeyEntry = {
		key: string;
		name: string;
		file: string;
	};

	const symbolEntries: SymbolKeyEntry[] = [];
	const seenKeys = new Set<string>();

	for (const result of results) {
		if (!result.symbolName || !result.filePath) {
			continue;
		}
		const key = `${result.symbolName}::${result.filePath}`;
		if (seenKeys.has(key)) {
			continue;
		}
		seenKeys.add(key);
		symbolEntries.push({
			key,
			name: result.symbolName,
			file: result.filePath,
		});
	}

	// Map from symbol key to in-degree.
	const inDegreeByKey = new Map<string, number>();

	if (symbolEntries.length > 0) {
		try {
			// Batch in-degree lookup for all symbols.
			const inDegreeCypher = `
				UNWIND $symbols AS sym
				MATCH (s {name: sym.name})<-[r]-()
				WHERE s.file = sym.file
				RETURN { key: sym.key, inDegree: count(r) } AS entry
			`;

			const degreeResult = await db.query(inDegreeCypher, {
				symbols: symbolEntries,
			});

			for (const record of degreeResult.rows ?? []) {
				const cell = record[0];
				if (typeof cell === 'object' && cell !== null && 'key' in cell) {
					const key = String((cell as any).key);
					const inDegreeValue =
						typeof (cell as any).inDegree === 'number'
							? (cell as any).inDegree
							: Number((cell as any).inDegree ?? 0);
					if (!Number.isNaN(inDegreeValue)) {
						inDegreeByKey.set(key, inDegreeValue);
					}
				}
			}
		} catch {
			// If the batched graph query fails, fall back to semantic scores only.
		}
	}

	for (const result of results) {
		let structuralImportance = 0;

		if (result.symbolName && result.filePath) {
			const key = `${result.symbolName}::${result.filePath}`;
			const inDegree = inDegreeByKey.get(key) ?? 0;
			// Normalize: log scale to prevent highly-referenced symbols from dominating
			structuralImportance = Math.log2(1 + inDegree) / 10;
		}
		// Combined score: per-agent-configurable split between semantic and structural signals.
		const relevanceScore = result.score * weights.semantic + structuralImportance * weights.structural;

		ranked.push({
			...result,
			relevanceScore,
			structuralImportance,
		});
	}

	return ranked;
}
