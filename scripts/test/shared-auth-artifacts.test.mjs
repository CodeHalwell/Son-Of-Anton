/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
const canonical = 'services/_shared/auth/dist/';
const artifacts = tracked.filter(file => file.startsWith(canonical) && !file.slice(canonical.length).includes('/')).map(file => path.basename(file));

for (const entry of tracked.filter(file => /\/_shared\/auth\/dist\/index\.js$/.test(file) && !file.startsWith(canonical))) {
	test(`Git-packaged shared auth loads with all siblings: ${entry}`, async t => {
		const directory = await mkdtemp(path.join(tmpdir(), 'sota-auth-artifact-'));
		t.after(() => rm(directory, { recursive: true, force: true }));
		await writeFile(path.join(directory, 'package.json'), '{"type":"commonjs"}');
		for (const name of artifacts) {
			const file = path.posix.join(path.posix.dirname(entry), name);
			assert.ok(tracked.includes(file), `${file} must be committed, not merely generated locally`);
			const contents = git(['show', `:${file}`]);
			assert.equal(contents, git(['show', `:${canonical}${name}`]), `${file} must match the canonical artifact`);
			await writeFile(path.join(directory, name), contents);
		}
		const auth = createRequire(path.join(directory, 'package.json'))('./index.js');
		assert.deepEqual([typeof auth.enforceHttpAuth, typeof auth.workspacePath, typeof auth.writeWorkspaceFile], ['function', 'function', 'function']);
		await auth.writeWorkspaceFile(directory, 'fixture.txt', 'packaged runtime');
		assert.equal(await auth.readWorkspaceFile(directory, 'fixture.txt'), 'packaged runtime');
	});
}
