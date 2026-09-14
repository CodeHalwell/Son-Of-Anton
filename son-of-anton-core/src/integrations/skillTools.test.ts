/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_SKILLS_TOOL, READ_SKILL_TOOL } from './skillTools';
import type { ToolExecutionContext } from '../tools/types';

test('disabled integrations deny both skill discovery and reading before accessing the catalog', async () => {
	const unavailable = async (): Promise<never> => { throw new Error('Disabled skills must not access tools'); };
	const context: ToolExecutionContext = { workspaceRoot: undefined, readFile: unavailable, readDir: unavailable, searchTextInWorkspace: unavailable, writeFile: unavailable, runCommand: unavailable, getConfigValue: <T>() => false as T };
	const results = await Promise.all([LIST_SKILLS_TOOL.execute({}, context), READ_SKILL_TOOL.execute({ id: 'ignored' }, context)]);
	assert.deepEqual(results, [{ content: 'System integrations are disabled.', isError: true }, { content: 'System integrations are disabled.', isError: true }]);
});
