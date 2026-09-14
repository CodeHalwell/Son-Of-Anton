/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) !== 22) { throw new Error('Use the Node 22 toolchain declared in .nvmrc before bootstrapping.'); }
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const packages = ['son-of-anton-core', 'son-of-anton-cli', 'services/code-graph/mcp-server', 'extensions/son-of-anton'];
for (const packageName of packages) {
	const directory = path.join(root, packageName);
	if (!process.argv.includes('--skip-install')) { run(npm, ['ci', '--no-audit', '--no-fund'], directory); }
	if (packageName !== 'extensions/son-of-anton') { run(npm, ['run', 'build'], directory); }
}
run(process.execPath, ['scripts/sync-service-auth.mjs']);
run(process.execPath, ['scripts/sync-acp-runtime.mjs']);
run(process.execPath, ['scripts/build-codegraph-runtime.mjs', ...(process.argv.includes('--debug') ? ['--debug'] : [])]);
run(process.execPath, ['--import', 'tsx', 'esbuild.mts'], path.join(root, 'extensions/son-of-anton'));
console.log('Son of Anton runtime, CLI, extension and native graph are built. Run npm run test:sota:offline next.');
