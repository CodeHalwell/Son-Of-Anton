/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
const { build } = createRequire(new URL('../son-of-anton-cli/package.json', import.meta.url))('esbuild');
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const debug = process.argv.includes('--debug');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
run('cargo', ['build', '--locked', '-p', 'sota-codegraph-napi', ...(debug ? [] : ['--release'])], path.join(root, 'crates'));
const output = path.join(root, 'extensions/son-of-anton/runtime/codegraph');
const native = path.join(output, 'node_modules/@son-of-anton/codegraph-napi');
await mkdir(native, { recursive: true });
const filename = process.platform === 'win32' ? 'sota_codegraph_napi.dll' : process.platform === 'darwin' ? 'libsota_codegraph_napi.dylib' : 'libsota_codegraph_napi.so';
await copyFile(path.join(root, 'crates/target', debug ? 'debug' : 'release', filename), path.join(native, 'engine.node'));
await writeFile(path.join(native, 'index.js'), `module.exports = require('./engine.node');\n`);
await writeFile(path.join(native, 'package.json'), JSON.stringify({ name: '@son-of-anton/codegraph-napi', version: '0.1.0', main: 'index.js' }));
await build({ entryPoints: [path.join(root, 'services/code-graph/mcp-server/src/index.ts')], outfile: path.join(output, 'index.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['@son-of-anton/codegraph-napi'], logLevel: 'warning' });
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, nodeMajor: 22, native: 'node_modules/@son-of-anton/codegraph-napi/engine.node' }, null, '\t') + '\n');
console.log(`Code graph runtime: ${output}`);
