/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { chmod, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/** Public application assets must not inherit the builder's private umask. */
export async function installPermissions(directory) {
	if (!(await lstat(directory)).isDirectory()) { throw new Error('Installation root must be a directory.'); }
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) { await installPermissions(file); }
		else if (entry.isFile()) { await chmod(file, (await lstat(file)).mode & 0o111 ? 0o755 : 0o644); }
	}
	// Symlinks stay untouched, including links to files outside the artifact.
	await chmod(directory, 0o755);
}
