/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url)), output = path.join(root, '.build/publish-ide');
const manifest = JSON.parse(await readFile(path.join(output, 'build-manifest.json'))), tag = `ide-v${manifest.ideVersion}`;
assert.match(tag, /^ide-v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
assert.equal(manifest.commit, process.env.GITHUB_SHA);
if (process.env.GITHUB_REF?.startsWith('refs/tags/')) { assert.equal(process.env.GITHUB_REF, `refs/tags/${tag}`, 'Release tag must match package.json version'); }
const repo = process.env.GITHUB_REPOSITORY; assert.match(repo ?? '', /^[\w.-]+\/[\w.-]+$/);
const existing = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { encoding: 'utf8' });
if (existing.status === 0) { throw new Error('This release already exists. Existing releases and downloads are never overwritten.'); }
const ref = spawnSync('gh', ['api', `repos/${repo}/git/ref/tags/${tag}`], { encoding: 'utf8' });
if (ref.status === 0) {
	let object = JSON.parse(ref.stdout).object;
	if (object.type === 'tag') { const resolved = spawnSync('gh', ['api', object.url], { encoding: 'utf8' }); assert.equal(resolved.status, 0); object = JSON.parse(resolved.stdout).object; }
	assert.equal(object.type, 'commit'); assert.equal(object.sha, manifest.commit, 'Tag points at a different commit');
} else if (!ref.stderr.includes('404')) { throw new Error('Unable to verify the release tag'); }
const notes = path.join(root, '.build/ide-release-notes.md');
await writeFile(notes, `Download the installer for your operating system below. See INSTALLATION.md for installation, checksum verification, updates and recovery.\n\nBuilt from ${manifest.commit}. All four native installation jobs passed before these assets were staged.\n\n${manifest.builds.map(build => `- ${build.target}: ${build.signing}`).join('\n')}\n\nProvider sign-in is completed on first use. Model credentials are never bundled.\n`);
const result = spawnSync('gh', ['release', 'create', tag, '--repo', repo, '--target', manifest.commit, '--title', `Son of Anton IDE ${manifest.ideVersion}`, '--draft', '--prerelease', '--notes-file', notes, ...(await readdir(output)).map(file => path.join(output, file))], { stdio: 'inherit' });
assert.equal(result.status, 0, 'Draft release creation failed');
