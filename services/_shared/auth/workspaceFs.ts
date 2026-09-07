/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export class WorkspacePathError extends Error { }

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Resolve relative or absolute workspace paths and reject every symlink component. */
export async function workspacePath(root: string, input: string, allowRoot = false): Promise<string> {
	if (typeof input !== 'string' || !input || input.includes('\0')) {
		throw new WorkspacePathError('Invalid workspace path');
	}
	const base = await fs.realpath(root);
	const lexicalBase = path.resolve(root);
	const requested = path.resolve(lexicalBase, input);
	let relative = path.relative(lexicalBase, requested);
	if (path.isAbsolute(input) && (input === base || input.startsWith(base + path.sep))) {
		relative = path.relative(base, input);
	}
	if ((!relative && !allowRoot) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
		throw new WorkspacePathError('Path must be inside the workspace');
	}
	let current = base;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		try {
			const entry = await fs.lstat(current);
			if (entry.isSymbolicLink()) {
				throw new WorkspacePathError('Symlinks are not allowed in workspace operations');
			}
			if (await fs.realpath(current) !== current) {
				throw new WorkspacePathError('Workspace path changed during validation');
			}
		} catch (error) {
			if (!missing(error)) { throw error; }
		}
	}
	return current;
}

/** Read through a non-following file handle; only absence represents a missing file. */
export async function readWorkspaceFile(root: string, input: string): Promise<string | undefined> {
	const target = await workspacePath(root, input);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (missing(error)) { return undefined; }
		throw error;
	}
	try {
		const opened = await handle.stat();
		const checked = await fs.lstat(await workspacePath(root, input));
		if (!opened.isFile() || opened.ino !== checked.ino || opened.dev !== checked.dev) {
			throw new WorkspacePathError('Workspace file changed during read');
		}
		return await handle.readFile('utf8');
	} finally {
		await handle.close();
	}
}

/** Replace files atomically, avoiding truncation through symlinks or hard links. */
export async function writeWorkspaceFile(root: string, input: string, content: string): Promise<void> {
	const target = await workspacePath(root, input);
	const parent = path.dirname(target);
	await fs.mkdir(parent, { recursive: true });
	await workspacePath(root, input);
	let mode = 0o600;
	try {
		const original = await fs.lstat(target);
		if (!original.isFile()) { throw new WorkspacePathError('Workspace target must be a regular file'); }
		mode = original.mode & 0o777;
	} catch (error) { if (!missing(error)) { throw error; } }
	const temporary = path.join(parent, `.sota-restore-${randomUUID()}`);
	try {
		await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
		await fs.chmod(temporary, mode);
		await workspacePath(root, input);
		await fs.rename(temporary, target);
	} finally {
		await fs.unlink(temporary).catch(error => { if (!missing(error)) { throw error; } });
	}
}

export async function removeWorkspaceFile(root: string, input: string): Promise<void> {
	const target = await workspacePath(root, input);
	await fs.unlink(target).catch(error => { if (!missing(error)) { throw error; } });
}
