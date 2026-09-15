/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Build a complete artifact set without changing the last successful output. */
export async function withStagedDirectory(destination, build, move = rename) {
	const parent = path.dirname(destination);
	await mkdir(parent, { recursive: true });
	const temporary = await mkdtemp(path.join(parent, `.${path.basename(destination)}-staging-`));
	const staged = path.join(temporary, 'new');
	const backup = path.join(temporary, 'previous');
	await mkdir(staged);
	let previous = false, retainBackup = false;
	try {
		await build(staged);
		try { await move(destination, backup); previous = true; }
		catch (error) { if (error.code !== 'ENOENT') { throw error; } }
		try { await move(staged, destination); }
		catch (error) {
			if (previous) {
				try { await move(backup, destination); }
				catch {
					retainBackup = true;
					throw new Error(`Artifact replacement failed; previous release retained at ${backup}`, { cause: error });
				}
			}
			throw error;
		}
	} finally {
		if (!retainBackup) { await rm(temporary, { recursive: true, force: true }); }
	}
}
