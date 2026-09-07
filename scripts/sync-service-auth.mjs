/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { readdir, readFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'services/_shared/auth');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(source, 'tsconfig.json')], { stdio: 'inherit' });
const files = (await readdir(path.join(source, 'dist'))).filter(file => /\.(js|map|ts)$/.test(file));
for (const service of await readdir(path.join(root, 'services'))) {
	const destination = path.join(root, 'services', service, '_shared/auth/dist');
	if (!existsSync(destination) && service !== 'background-tasks') { continue; }
	if (process.argv.includes('--check')) {
		for (const file of files) {
			if (!existsSync(path.join(destination, file)) || !(await readFile(path.join(source, 'dist', file))).equals(await readFile(path.join(destination, file)))) {
				throw new Error(`Stale shared service module: ${service}/${file}. Run node scripts/sync-service-auth.mjs.`);
			}
		}
	} else {
		await mkdir(destination, { recursive: true });
		for (const file of files) { await copyFile(path.join(source, 'dist', file), path.join(destination, file)); }
	}
}

// Type definitions and runtime guards are built from the same canonical contract.
const eventsSource = path.join(root, 'services/_shared/agent-events');
const eventsDestination = path.join(root, 'services/model-router/_shared/agent-events/dist');
execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(eventsSource, 'tsconfig.json')], { stdio: 'inherit' });
for (const file of ['index.js', 'index.js.map', 'index.d.ts']) {
	const from = path.join(eventsSource, 'dist', file);
	const to = path.join(eventsDestination, file);
	if (process.argv.includes('--check')) {
		if (!existsSync(to) || !(await readFile(from)).equals(await readFile(to))) { throw new Error('Stale shared agent-event contract. Run node scripts/sync-service-auth.mjs.'); }
	} else { await mkdir(eventsDestination, { recursive: true }); await copyFile(from, to); }
}
