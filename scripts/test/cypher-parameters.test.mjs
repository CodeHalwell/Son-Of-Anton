/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parameterizedQuery } = require('../../services/_shared/cypher/dist/index.js');

test('graph parameters serialize nested maps and lists as Cypher data', () => {
	const query = parameterizedQuery('UNWIND $functions AS fn RETURN fn.name', { functions: [{ name: 'cartTotal', exported: true, optional: undefined, line: 1 }], empty: [], missing: null });
	assert.equal(query, 'CYPHER functions=[{name:"cartTotal",exported:true,optional:null,line:1}] empty=[] missing=null UNWIND $functions AS fn RETURN fn.name');
});
test('graph parameters keep quotes and query-like strings inside literals', () => {
	const value = '\" RETURN 1 //\\\n';
	assert.equal(parameterizedQuery('RETURN $value', { value }), `CYPHER value=${JSON.stringify(value)} RETURN $value`);
	for (const value of [NaN, Infinity, () => {}, new Date()]) { assert.throws(() => parameterizedQuery('RETURN $value', { value }), /Unsupported/); }
	assert.throws(() => parameterizedQuery('RETURN 1', { 'x RETURN 1 //': 1 }), /Invalid/);
	assert.throws(() => parameterizedQuery('RETURN $value', { value: { 'x:y': 1 } }), /Invalid/);
});

test('compact graph replies retain column names, booleans, numbers, arrays, and maps', () => {
	const { decodeCompactResult } = require('../../services/_shared/cypher/dist/index.js');
	const reply = [
		[[1, 'name'], [1, 'exported'], [1, 'line'], [1, 'topics'], [1, 'entry'], [1, 'empty']],
		[[[2, 'cartTotal'], [4, 'false'], [3, 42], [6, [[2, 'cart'], [5, '1.5']]], [10, ['file', [2, 'cart.js']]], [1, null]]],
		['Cached execution: 0'],
	];
	assert.deepEqual(decodeCompactResult(reply), {
		headers: ['name', 'exported', 'line', 'topics', 'entry', 'empty'],
		rows: [['cartTotal', false, 42, ['cart', 1.5], { file: 'cart.js' }, null]],
	});
	assert.deepEqual(decodeCompactResult([['Nodes created: 1']]), { headers: [], rows: [] });
	assert.throws(() => decodeCompactResult([[[1, 'node']], [[[8, []]]]]), /Unsupported/);
});

test('canonical and vendored graph serializers execute inside CommonJS package boundaries', async () => {
	const { readFile } = await import('node:fs/promises');
	const { compileFunction } = await import('node:vm');
	for (const service of ['_shared', 'indexer/_shared', 'lsif/_shared', 'mcp-gateway/_shared']) {
		const url = new URL(`../../services/${service}/cypher/dist/index.js`, import.meta.url);
		const module = { exports: {} };
		// Explicit CommonJS parsing catches ESM exports even on Node versions that auto-detect ESM.
		compileFunction(await readFile(url, 'utf8'), ['exports', 'require', 'module'])(module.exports, require, module);
		assert.equal(module.exports.parameterizedQuery('RETURN $value', { value: 42 }), 'CYPHER value=42 RETURN $value');
	}
});
