/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const credentialNames = ['SOTA_SERVICE_TOKEN', 'FALKORDB_PASSWORD', 'QDRANT_API_KEY', 'BACKGROUND_TASK_API_TOKEN', 'DB_PASSWORD', 'POSTGRES_ADMIN_PASSWORD'];

/** Generate independent secrets without copying provider credentials or overwriting an existing file. */
export async function configureServices(destination = resolve('.env')) {
	let contents = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
	for (const name of credentialNames) {
		const pattern = new RegExp(`^${name}=.*$`, 'gm');
		if ([...contents.matchAll(pattern)].length !== 1) { throw new Error(`Expected one ${name} field in .env.example`); }
		contents = contents.replace(pattern, `${name}=${randomBytes(32).toString('hex')}`);
	}
	// Exclusive creation also rejects a pre-existing symlink at the destination.
	await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
	return resolve(destination);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const args = process.argv.slice(2);
		if (args.length && (args.length !== 2 || args[0] !== '--output')) { throw new Error('Usage: node scripts/configure-services.mjs [--output path]'); }
		const destination = await configureServices(args[1]);
		console.log(`Created private service configuration: ${destination}\nReview optional provider settings, then run docker compose --profile services up -d.`);
	} catch (error) {
		console.error(error.code === 'EEXIST' ? 'Configuration already exists; it was not changed. Set the required service and datastore credentials in that file.' : error.message);
		process.exitCode = 1;
	}
}
