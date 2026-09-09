/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { readdir, readFile, mkdtemp, cp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
// Compile only ACP entry points and their transitive dependencies. A clean output
// prevents unrelated/stale LLM modules from a previous core build being vendored.
// Keep the same directory depth as core/dist so source maps stay deterministic.
const source = await mkdtemp(path.join(root, 'son-of-anton-core/.acp-runtime-'));
const destination = path.join(root, 'services/acp-client/_shared/acp/dist');

async function files(directory, prefix = '') {
	const result = [];
	for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
		const relative = path.join(prefix, entry.name);
		if (entry.isDirectory()) { result.push(...await files(directory, relative)); }
		else { result.push(relative); }
	}
	return result.sort();
}

try {
	execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, 'son-of-anton-core/tsconfig.acp.json'), '--outDir', source], { stdio: 'inherit' });
	if (process.argv.includes('--check')) {
		const expected = await files(source);
		const actual = await files(destination).catch(error => { if (error.code === 'ENOENT') { return []; } throw error; });
		if (JSON.stringify(expected) !== JSON.stringify(actual)) { throw new Error('Stale ACP runtime files. Run node scripts/sync-acp-runtime.mjs.'); }
		for (const file of expected) {
			if (!(await readFile(path.join(source, file))).equals(await readFile(path.join(destination, file)))) { throw new Error(`Stale ACP runtime: ${file}. Run node scripts/sync-acp-runtime.mjs.`); }
		}
	} else {
		await rm(destination, { recursive: true, force: true });
		await cp(source, destination, { recursive: true });
	}
	// Load the staged runtime from the standalone service, catching missing local
	// dependencies even when the generated-file comparison itself is up to date.
	execFileSync(process.execPath, [path.join(root, 'services/acp-client/scripts/check-runtime.cjs')], { stdio: 'inherit' });
} finally { await rm(source, { recursive: true, force: true }); }
