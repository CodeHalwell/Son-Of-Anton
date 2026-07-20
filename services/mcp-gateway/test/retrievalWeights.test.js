// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

// Tests for per-agent hybrid retrieval scoring weights (F-3).
// Runs against the esbuild output in dist/ — `npm test` builds first.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
	DEFAULT_RETRIEVAL_WEIGHTS,
	resolveRetrievalWeights,
} = require('../dist/retrievalWeights.js');

describe('resolveRetrievalWeights', () => {
	test('falls back to the hard-coded default when the config is empty', () => {
		assert.deepStrictEqual(resolveRetrievalWeights({}, 'anton-code'), DEFAULT_RETRIEVAL_WEIGHTS);
	});

	test('falls back to the hard-coded default when agentRole is unset and there is no catch-all', () => {
		assert.deepStrictEqual(resolveRetrievalWeights({}, undefined), DEFAULT_RETRIEVAL_WEIGHTS);
	});

	test('uses the "*" catch-all when the agent handle has no dedicated entry', () => {
		const config = { '*': { semantic: 0.7, structural: 0.3 } };
		assert.deepStrictEqual(resolveRetrievalWeights(config, 'anton-docs'), { semantic: 0.7, structural: 0.3 });
	});

	test('prefers an exact agent-handle match over the "*" catch-all', () => {
		const config = {
			'anton-review': { semantic: 0.6, structural: 0.4 },
			'*': { semantic: 0.8, structural: 0.2 },
		};
		assert.deepStrictEqual(resolveRetrievalWeights(config, 'anton-review'), { semantic: 0.6, structural: 0.4 });
		assert.deepStrictEqual(resolveRetrievalWeights(config, 'anton-code'), { semantic: 0.8, structural: 0.2 });
	});
});
