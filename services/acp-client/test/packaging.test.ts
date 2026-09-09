/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
async function packageFixture(t: TestContext) {
	const directory = await mkdtemp(path.join(tmpdir(), 'sota-acp-package-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await cp('_shared/acp/dist', path.join(directory, '_shared/acp/dist'), { recursive: true });
	await mkdir(path.join(directory, 'scripts'));
	await cp('scripts/check-runtime.cjs', path.join(directory, 'scripts/check-runtime.cjs'));
	await cp('package.json', path.join(directory, 'package.json'));
	await symlink(await realpath('node_modules'), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
	const check = () => exec(process.execPath, [path.join(directory, 'scripts/check-runtime.cjs')], { cwd: directory, timeout: 10000 });
	return { directory, check };
}

test('the standalone runtime import check detects an omitted transitive catalog module', async t => {
	const { directory, check } = await packageFixture(t);
	await check();
	await rm(path.join(directory, '_shared/acp/dist/llm/DiscoveredModels.js'));
	await assert.rejects(check(), /Cannot find module '\.\.\/llm\/DiscoveredModels'/);
});

test('the standalone runtime import check rejects dependencies available only through development tooling', async t => {
	const { directory, check } = await packageFixture(t);
	const entry = path.join(directory, '_shared/acp/dist/acp/AcpRuntime.js');
	await writeFile(entry, `require('typescript');\n${await readFile(entry, 'utf8')}`);
	await assert.rejects(check(), /ACP runtime dependency is not declared by the service: typescript/);
});
