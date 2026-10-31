/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CodeGraphSourceLocation } from '@codypendent/protocol';

/** Resolve recorded source locations at navigation time, including symlink boundaries. */
export async function resolveGraphSource(repository: string, location: Pick<CodeGraphSourceLocation, 'source_path' | 'line' | 'column'>): Promise<string> {
	if (!location.source_path || !Number.isSafeInteger(location.line) || location.line < 1
		|| !Number.isSafeInteger(location.column) || location.column < 1) {
		throw new Error('The recorded source location is invalid.');
	}
	const root = await realpath(repository);
	const filename = await realpath(path.resolve(root, location.source_path));
	const relative = path.relative(root, filename);
	if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error('The recorded source is outside this repository.');
	}
	if (!(await stat(filename)).isFile()) { throw new Error('The recorded source is not a file.'); }
	return filename;
}

/** Protocol columns count Unicode characters; editor offsets count UTF-16 code units. */
export function graphColumnOffset(text: string, column: number): number {
	if (!Number.isSafeInteger(column) || column < 1) { throw new Error('The recorded source column is invalid.'); }
	return [...text].slice(0, column - 1).join('').length;
}
