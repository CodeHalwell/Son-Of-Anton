/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withStagedDirectory } from '../staged-directory.mjs';

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-staged-release-test-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const output = path.join(root, 'release');
	await mkdir(output);
	await writeFile(path.join(output, 'obsolete.zip'), 'previous release');
	return { root, output };
}

test('artifact replacement contains only the complete new build and removes stale reports', async t => {
	const { root, output } = await fixture(t);
	await withStagedDirectory(output, async staged => {
		assert.deepEqual(await readdir(staged), []);
		await writeFile(path.join(staged, 'current.zip'), 'new release');
		assert.equal(await readFile(path.join(output, 'obsolete.zip'), 'utf8'), 'previous release');
	});
	assert.deepEqual(await readdir(output), ['current.zip']);
	assert.deepEqual(await readdir(root), ['release']);
});

test('failed packaging keeps the previous release intact and removes partial output', async t => {
	const { root, output } = await fixture(t);
	await assert.rejects(withStagedDirectory(output, async staged => {
		await writeFile(path.join(staged, 'partial.zip'), 'incomplete');
		throw new Error('archive failed');
	}), /archive failed/);
	assert.equal(await readFile(path.join(output, 'obsolete.zip'), 'utf8'), 'previous release');
	assert.deepEqual(await readdir(root), ['release']);
});

test('replacement failure restores the previous release', async t => {
	const { root, output } = await fixture(t);
	await assert.rejects(withStagedDirectory(output, async staged => {
		await writeFile(path.join(staged, 'current.zip'), 'new');
	}, async (source, target) => {
		if (path.basename(source) === 'new') { throw new Error('replacement denied'); }
		await rename(source, target);
	}), /replacement denied/);
	assert.equal(await readFile(path.join(output, 'obsolete.zip'), 'utf8'), 'previous release');
	assert.deepEqual(await readdir(root), ['release']);
});

test('a failed rollback retains the original release at the reported recovery path', async t => {
	const { root, output } = await fixture(t);
	await assert.rejects(withStagedDirectory(output, async () => {}, async (source, target) => {
		if (source !== output) { throw new Error('destination inaccessible'); }
		await rename(source, target);
	}), /previous release retained at/);
	const [recovery] = await readdir(root);
	assert.equal(await readFile(path.join(root, recovery, 'previous/obsolete.zip'), 'utf8'), 'previous release');
});
