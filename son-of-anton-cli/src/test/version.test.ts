/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SOTA_VERSION, compareSemver, isStrictlyGreater, tagToVersion } from '../version';

test('SOTA_VERSION resolves to a real semver, not the dev fallback', () => {
	// If the package.json require were broken (the pre-fix `__dirname` bug),
	// this would be the fallback and every update check would report "outdated".
	assert.match(SOTA_VERSION, /^\d+\.\d+\.\d+/);
	assert.notEqual(SOTA_VERSION, '0.0.0');
	assert.notEqual(SOTA_VERSION, '0.0.0-dev');
});

test('tagToVersion strips the sota-v prefix and tolerates bare versions', () => {
	const actual = ['sota-v0.1.0', 'sota-v1.2.3', 'sota-v0.10.0', '0.4.2'].map(tagToVersion);
	assert.deepEqual(actual, ['0.1.0', '1.2.3', '0.10.0', '0.4.2']);
});

test('compareSemver orders versions numerically (not lexicographically)', () => {
	// Each row: [a, b, expected sign of compareSemver(a, b)].
	const cases: ReadonlyArray<[string, string, number]> = [
		['0.10.0', '0.9.0', 1], // the lexicographic-sort bug: '0.10.0' must win
		['0.9.0', '0.10.0', -1],
		['1.0.0', '0.99.99', 1],
		['1.2.3', '1.2.3', 0],
		['2.0.0', '1.9.9', 1],
		['1.0.1', '1.0.0', 1],
		['1.0.0', '1.0.0-rc.1', 1], // a release outranks its pre-release
		['1.0.0-rc.1', '1.0.0-rc.2', -1],
		['1.0.0-alpha', '1.0.0-beta', -1],
		['1.0.0-rc.2', '1.0.0-rc.10', -1], // numeric pre-release identifiers
	];
	const actual = cases.map(([a, b]) => Math.sign(compareSemver(a, b)));
	assert.deepEqual(actual, cases.map(([, , expected]) => expected));
});

test('compareSemver is a correct descending sort comparator', () => {
	const tags = ['sota-v0.9.0', 'sota-v0.10.0', 'sota-v0.2.0', 'sota-v1.0.0', 'sota-v0.10.1'];
	const sorted = [...tags].sort((a, b) => compareSemver(tagToVersion(b), tagToVersion(a)));
	assert.deepEqual(sorted, ['sota-v1.0.0', 'sota-v0.10.1', 'sota-v0.10.0', 'sota-v0.9.0', 'sota-v0.2.0']);
});

test('isStrictlyGreater is true only for a strictly higher version', () => {
	const actual = [
		isStrictlyGreater('0.2.0', '0.1.0'),
		isStrictlyGreater('0.10.0', '0.9.0'),
		isStrictlyGreater('0.1.0', '0.1.0'),
		isStrictlyGreater('0.1.0', '0.2.0'),
		isStrictlyGreater('1.0.0', '1.0.0-rc.1'),
	];
	assert.deepEqual(actual, [true, true, false, false, true]);
});
