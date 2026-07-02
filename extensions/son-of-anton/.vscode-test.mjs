// @ts-check
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from '@vscode/test-cli';

// The whole suite is written against Mocha's TDD interface (`suite` / `test` /
// `setup` / `teardown`), so the harness must select `ui: 'tdd'` — the default
// BDD interface would silently register zero tests. Compiled test output lands
// in `out-test/` (see `tsconfig.test.json`); both the `test/*.test.ts` files
// and the co-located `src/**/*.test.ts` files are globbed here.
export default defineConfig({
	files: ['out-test/test/**/*.test.js', 'out-test/src/**/*.test.js'],
	mocha: {
		ui: 'tdd',
		timeout: 20000,
		// `son-of-anton-core` is consumed as a bare specifier but isn't linked
		// into node_modules; this hook points those imports at the built dist so
		// the extension-host process can resolve them. (The genuine `vscode`
		// module is injected by the harness, so no vscode shim is needed here.)
		require: ['./test/coreResolve.cjs'],
	},
});
