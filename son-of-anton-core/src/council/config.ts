/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { defaultCouncilGroup, validateGroup } from './prompts';
import type { CouncilGroup } from './types';

export function councilDirectory(workspace: string): string { return join(homedir(), '.son-of-anton', 'councils', createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 24)); }
export async function readCouncilGroups(directory: string, model = 'sonnet'): Promise<CouncilGroup[]> {
	const file = join(directory, 'groups.json');
	try {
		if ((await stat(file)).size > 128 * 1024) { throw new Error('Council groups file exceeds 128 KiB'); }
		const groups = JSON.parse(await readFile(file, 'utf8')) as CouncilGroup[];
		if (!Array.isArray(groups) || !groups.length || groups.length > 64 || new Set(groups.map(group => group.id)).size !== groups.length) { throw new Error('Expected 1–64 unique Council groups'); }
		groups.forEach(validateGroup); return groups;
	} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return [defaultCouncilGroup(model)]; } throw error; }
}
export async function createCouncilGroupsFile(directory: string, model = 'sonnet'): Promise<string> {
	const file = join(directory, 'groups.json'); await mkdir(directory, { recursive: true, mode: 0o700 });
	try { await writeFile(file, JSON.stringify([defaultCouncilGroup(model)], null, '\t') + '\n', { flag: 'wx', mode: 0o600 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; } }
	return file;
}
