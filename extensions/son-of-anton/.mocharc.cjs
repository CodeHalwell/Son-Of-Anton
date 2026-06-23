'use strict';

module.exports = {
	require: ['./test/setup.cjs', 'tsx/cjs'],
	spec: 'test/**/*.test.ts',
	timeout: 10000,
	reporter: 'spec',
};
