/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { readdir, readFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'son-of-anton-core/tsconfig.acp.json')], { stdio: 'inherit' });
const source = path.join(root, 'son-of-anton-core/dist/acp');
const destination = path.join(root, 'services/acp-client/_shared/acp/dist');
await mkdir(destination, { recursive: true });
for (const file of await readdir(source)) {
	if (!/^(AcpPeer|AcpConnection|AcpRuntime|protocol)\.(js|js\.map|d\.ts|d\.ts\.map)$/.test(file)) { continue; }
	const from = path.join(source, file), to = path.join(destination, file);
	if (process.argv.includes('--check')) {
		if (!(await readFile(from)).equals(await readFile(to))) { throw new Error('Stale ACP runtime. Run node scripts/sync-acp-runtime.mjs.'); }
	} else { await copyFile(from, to); }
}
