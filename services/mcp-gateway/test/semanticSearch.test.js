// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

// Tests for hybrid retrieval scoring with per-agent weights (F-3).
// Runs against the esbuild output in dist/ — `npm test` builds first.

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { semanticSearch } = require('../dist/tools/semanticSearch.js');

function createMockQdrant(results) {
	return { search: mock.fn(async () => results) };
}

function createMockDbWithInDegree(inDegreeByKey) {
	return {
		query: mock.fn(async () => ({
			rows: Object.entries(inDegreeByKey).map(([key, inDegree]) => [{ key, inDegree }]),
		})),
	};
}

const embedQuery = async () => [0.1, 0.2, 0.3];

describe('semanticSearch — hybrid ranking weights', () => {
	test('defaults to the historical 0.8/0.2 semantic/structural split when no weights are passed', async () => {
		const qdrant = createMockQdrant([
			{ id: '1', score: 0.5, filePath: 'a.ts', startLine: 1, endLine: 2, content: '', language: 'ts', symbolName: 'foo' },
		]);
		const db = createMockDbWithInDegree({ 'foo::a.ts': 10 });

		const [result] = await semanticSearch(qdrant, db, { query: 'foo' }, embedQuery);

		const expectedStructural = Math.log2(1 + 10) / 10;
		assert.deepStrictEqual(
			{ structuralImportance: result.structuralImportance, relevanceScore: result.relevanceScore },
			{ structuralImportance: expectedStructural, relevanceScore: 0.5 * 0.8 + expectedStructural * 0.2 }
		);
	});

	test('applies caller-supplied weights instead of the default split', async () => {
		const qdrant = createMockQdrant([
			{ id: '1', score: 0.5, filePath: 'a.ts', startLine: 1, endLine: 2, content: '', language: 'ts', symbolName: 'foo' },
		]);
		const db = createMockDbWithInDegree({ 'foo::a.ts': 10 });
		const weights = { semantic: 0.6, structural: 0.4 };

		const [result] = await semanticSearch(qdrant, db, { query: 'foo' }, embedQuery, weights);

		const expectedStructural = Math.log2(1 + 10) / 10;
		assert.strictEqual(result.relevanceScore, 0.5 * 0.6 + expectedStructural * 0.4);
	});

	test('a structural-heavy weighting can re-rank a lower-semantic-score, highly-referenced result above a purely semantic top match', async () => {
		const qdrant = createMockQdrant([
			{ id: 'high-semantic', score: 0.9, filePath: 'a.ts', startLine: 1, endLine: 2, content: '', language: 'ts', symbolName: 'lonely' },
			{ id: 'high-structural', score: 0.5, filePath: 'b.ts', startLine: 1, endLine: 2, content: '', language: 'ts', symbolName: 'central' },
		]);
		const db = createMockDbWithInDegree({ 'lonely::a.ts': 0, 'central::b.ts': 1000 });

		const results = await semanticSearch(qdrant, db, { query: 'x' }, embedQuery, { semantic: 0.1, structural: 0.9 });

		assert.strictEqual(results[0].id, 'high-structural');
	});
});
