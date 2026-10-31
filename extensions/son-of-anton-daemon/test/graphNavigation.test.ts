/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { graphColumnOffset, resolveGraphSource } from '../src/graphNavigation.js';

describe('graph source navigation', () => {
	let directory: string;
	let repository: string;
	beforeEach(async () => {
		directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anton-graph-source-')));
		repository = path.join(directory, 'repository');
		await mkdir(repository);
		await writeFile(path.join(repository, 'source.ts'), 'export const graph = true;\n');
		await writeFile(path.join(directory, 'outside.ts'), 'private');
	});
	afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
	it('opens only real files inside the canonical repository', async () => {
		const location = { source_path: 'source.ts', line: 1, column: 1 };
		expect(await resolveGraphSource(repository, location)).toBe(path.join(repository, 'source.ts'));
		expect(await resolveGraphSource(repository, { ...location, source_path: path.join(repository, 'source.ts') })).toBe(path.join(repository, 'source.ts'));
		await expect(resolveGraphSource(repository, { ...location, source_path: '../outside.ts' })).rejects.toThrow('outside');
		await expect(resolveGraphSource(repository, { ...location, source_path: path.join(directory, 'outside.ts') })).rejects.toThrow('outside');
		await expect(resolveGraphSource(repository, { ...location, source_path: '.' })).rejects.toThrow();
	});
	it('rejects a source symlink that escapes the repository', async () => {
		await symlink(path.join(directory, 'outside.ts'), path.join(repository, 'linked.ts'));
		await expect(resolveGraphSource(repository, { source_path: 'linked.ts', line: 1, column: 1 })).rejects.toThrow('outside');
	});
	it('rejects invalid source coordinates before navigation', async () => {
		for (const location of [
			{ source_path: 'source.ts', line: 0, column: 1 },
			{ source_path: 'source.ts', line: 1, column: -1 },
			{ source_path: 'source.ts', line: 1.5, column: 1 },
			{ source_path: '', line: 1, column: 1 },
		]) { await expect(resolveGraphSource(repository, location)).rejects.toThrow('invalid'); }
	});
	it('converts Unicode source columns and clamps past the current line', () => {
		expect([1, 2, 3, 4, 100].map(column => graphColumnOffset('a😀z', column))).toEqual([0, 1, 3, 4, 4]);
		expect(() => graphColumnOffset('source', 0)).toThrow('invalid');
	});
});
