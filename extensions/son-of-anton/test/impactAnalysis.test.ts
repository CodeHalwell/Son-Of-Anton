/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as assert from 'assert';
import { transformToImpactData } from '../src/impact/ImpactAnalysisCommand';

suite('ImpactAnalysis', () => {
	test('embedded graph reports affected files without claiming direct callers or coverage', () => {
		const result = transformToImpactData('clamp', 'src/clamp.ts', ['src/clamp.ts', 'src/main.ts', 'src/main.ts']);
		assert.deepStrictEqual({ fileBased: result.fileBased, paths: result.nodes.map(node => node.filePath), summary: result.summary }, { fileBased: true, paths: ['src/main.ts'], summary: { directCount: 0, transitiveCount: 1, testCount: 0, documentationCount: 0 } });
	});
	test('Docker graph retains symbol and coverage information', () => {
		const result = transformToImpactData('clamp', 'src/clamp.ts', { directCallers: [{ name: 'main', file: 'src/main.ts' }], tests: [{ file: 'test/clamp.ts' }] });
		assert.deepStrictEqual(result.summary, { directCount: 1, transitiveCount: 0, testCount: 1, documentationCount: 0 });
	});
});
