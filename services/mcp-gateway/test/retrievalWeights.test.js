// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

// Tests for per-agent hybrid retrieval scoring weights (F-3).
// Runs against the esbuild output in dist/ — `npm test` builds first.

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
	DEFAULT_RETRIEVAL_WEIGHTS,
	resolveRetrievalWeights,
	loadRetrievalWeightsConfig,
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

	test('fills in a partial config entry from the default instead of leaving a field undefined', () => {
		const config = { 'anton-code': { semantic: 0.5 } };
		assert.deepStrictEqual(
			resolveRetrievalWeights(config, 'anton-code'),
			{ semantic: 0.5, structural: DEFAULT_RETRIEVAL_WEIGHTS.structural }
		);
	});

	test('falls back to the default for a non-numeric field instead of propagating a value that would NaN the score', () => {
		const config = { 'anton-code': { semantic: 'high', structural: 0.4 } };
		assert.deepStrictEqual(
			resolveRetrievalWeights(config, 'anton-code'),
			{ semantic: DEFAULT_RETRIEVAL_WEIGHTS.semantic, structural: 0.4 }
		);
	});

	test('falls back to the default entirely when the role entry is not an object', () => {
		assert.deepStrictEqual(
			resolveRetrievalWeights({ 'anton-code': null }, 'anton-code'),
			DEFAULT_RETRIEVAL_WEIGHTS
		);
	});
});

describe('loadRetrievalWeightsConfig', () => {
	let tmpDir;
	let originalEnv;
	let originalCwd;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-retrieval-weights-test-'));
		originalEnv = process.env.RETRIEVAL_WEIGHTS_CONFIG;
		originalCwd = process.cwd();
		// Isolate from the real repo-root `.son-of-anton/retrieval-weights.json` —
		// otherwise the loader's cwd-relative candidates would fall through to it
		// once the explicit (malformed) path is rejected, making these tests
		// depend on that file's actual committed contents.
		process.chdir(tmpDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		process.env.RETRIEVAL_WEIGHTS_CONFIG = originalEnv;
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test('rejects a non-object JSON root (e.g. `null`) instead of returning it as the config', () => {
		const configPath = path.join(tmpDir, 'retrieval-weights.json');
		fs.writeFileSync(configPath, 'null');
		process.env.RETRIEVAL_WEIGHTS_CONFIG = configPath;

		const config = loadRetrievalWeightsConfig();

		assert.deepStrictEqual(config, {});
		// And the empty fallback must not throw when resolved, unlike indexing `null`.
		assert.deepStrictEqual(resolveRetrievalWeights(config, 'anton-code'), DEFAULT_RETRIEVAL_WEIGHTS);
	});

	test('rejects a JSON array root', () => {
		const configPath = path.join(tmpDir, 'retrieval-weights.json');
		fs.writeFileSync(configPath, '[]');
		process.env.RETRIEVAL_WEIGHTS_CONFIG = configPath;

		assert.deepStrictEqual(loadRetrievalWeightsConfig(), {});
	});

	test('loads a well-formed config from the explicit path', () => {
		const configPath = path.join(tmpDir, 'retrieval-weights.json');
		fs.writeFileSync(configPath, JSON.stringify({ '*': { semantic: 0.7, structural: 0.3 } }));
		process.env.RETRIEVAL_WEIGHTS_CONFIG = configPath;

		assert.deepStrictEqual(loadRetrievalWeightsConfig(), { '*': { semantic: 0.7, structural: 0.3 } });
	});
});
