/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Runtime resolver for `son-of-anton-core` bare imports.
 *
 * The extension consumes the core runtime as `son-of-anton-core` /
 * `son-of-anton-core/<subpath>`. At type-check time `tsconfig.json`'s `paths`
 * maps those onto `../../son-of-anton-core/dist/*.d.ts`, and the production
 * esbuild bundle inlines them — but neither mechanism applies when Node runs
 * the compiled test output directly. `son-of-anton-core` is not linked into any
 * `node_modules`, so both the `@vscode/test-cli` harness and the plain-Mocha
 * fallback need this hook to point the bare specifiers at the built `dist/`.
 *
 * Loaded via Mocha's `require` in `.vscode-test.mjs` and the `test:node` script.
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// test/ -> son-of-anton/ -> extensions/ -> <repo> -> son-of-anton-core/dist
const DIST = path.resolve(__dirname, '..', '..', '..', 'son-of-anton-core', 'dist');
const PREFIX = 'son-of-anton-core';

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === PREFIX || request.startsWith(`${PREFIX}/`)) {
		const sub = request === PREFIX ? 'index' : request.slice(PREFIX.length + 1);
		const candidates = [
			path.join(DIST, `${sub}.js`),
			path.join(DIST, sub, 'index.js'),
			path.join(DIST, sub),
		];
		for (const candidate of candidates) {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
				return candidate;
			}
		}
	}
	return originalResolveFilename.call(this, request, ...rest);
};
