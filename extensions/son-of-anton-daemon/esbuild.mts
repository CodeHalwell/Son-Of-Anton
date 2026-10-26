/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const absWorkingDir = fileURLToPath(new URL('.', import.meta.url));
await Promise.all([
	build({ absWorkingDir, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.cjs', bundle: true,
		platform: 'node', format: 'cjs', target: 'node22', external: ['vscode'], sourcemap: true }),
	build({ absWorkingDir, entryPoints: ['src/webview.ts'], outfile: 'dist/webview.js', bundle: true,
		platform: 'browser', format: 'iife', target: 'es2022', sourcemap: true }),
]);
