/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Son of Anton Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

module.exports = {
	require: ['./test/setup.cjs', 'tsx/cjs'],
	spec: 'test/**/*.test.ts',
	timeout: 10000,
	reporter: 'spec',
	ui: 'tdd',
};
