/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { patchLanguageClientGlobs } from '../../build/npm/patchLanguageClientGlobs.ts';

const run = promisify(execFile);

async function fixture(t, extension = 'html-language-features') {
	const temporary = await mkdtemp(path.join(tmpdir(), 'sota-client-globs-'));
	t.after(() => rm(temporary, { recursive: true, force: true }));
	const root = path.join(temporary, extension);
	const client = path.join(root, 'node_modules', 'vscode-languageclient');
	const original = new URL(`../../extensions/${extension}/node_modules/vscode-languageclient/`, import.meta.url);
	const manifest = await readFile(new URL('package.json', original), 'utf8');
	const files = extension === 'markdown-language-features'
		? ['lib/common/fileOperations.js', 'lib/common/notebook.js', 'lib/common/diagnostic.js']
		: ['lib/common/fileOperations.js', 'lib/common/utils/globPattern.js'];
	const contents = new Map();
	await mkdir(client, { recursive: true });
	await writeFile(path.join(client, 'package.json'), manifest);
	await mkdir(path.join(root, 'node_modules', 'minimatch'));
	await writeFile(path.join(root, 'node_modules', 'minimatch', 'package.json'), '{"version":"11.0.1"}');
	for (const name of files) {
		const source = (await readFile(new URL(name, original), 'utf8')).replace('matcher.set.length === 0', '!matcher.makeRe()');
		contents.set(name, source);
		await mkdir(path.dirname(path.join(client, name)), { recursive: true });
		await writeFile(path.join(client, name), source);
	}
	return { root, client, contents };
}

for (const extension of ['html-language-features', 'json-language-features', 'markdown-language-features']) {
	test(`${extension} compatibility patch is exact and idempotent`, async t => {
		const { root, client, contents } = await fixture(t, extension);
		patchLanguageClientGlobs(root);
		patchLanguageClientGlobs(root);
		for (const [name, source] of contents) {
			assert.equal(await readFile(path.join(client, name), 'utf8'), source.replace('!matcher.makeRe()', 'matcher.set.length === 0'));
		}
	});
}

test('unknown source or versions fail before writing any compatibility change', async t => {
	const { root, client, contents } = await fixture(t);
	const names = Array.from(contents.keys());
	await writeFile(path.join(client, names[1]), 'unreviewed source');
	assert.throws(() => patchLanguageClientGlobs(root), /Unreviewed.*source/);
	assert.equal(await readFile(path.join(client, names[0]), 'utf8'), contents.get(names[0]));
	await writeFile(path.join(client, names[1]), contents.get(names[1]));
	await writeFile(path.join(client, 'package.json'), '{"version":"999.0.0"}');
	assert.throws(() => patchLanguageClientGlobs(root), /Unreviewed.*version/);
	assert.equal(await readFile(path.join(client, names[0]), 'utf8'), contents.get(names[0]));
});

test('parallel bundle processes apply only complete known file states', async t => {
	const { root, client, contents } = await fixture(t, 'markdown-language-features');
	const module = new URL('../../build/npm/patchLanguageClientGlobs.ts', import.meta.url).href;
	const script = `import { patchLanguageClientGlobs } from ${JSON.stringify(module)}; patchLanguageClientGlobs(${JSON.stringify(root)});`;
	await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', script])));
	for (const [name, source] of contents) {
		assert.equal(await readFile(path.join(client, name), 'utf8'), source.replace('!matcher.makeRe()', 'matcher.set.length === 0'));
	}
});

test('the actual client-resolved matcher version is checked before writing', async t => {
	const { root, client, contents } = await fixture(t);
	const nested = path.join(client, 'node_modules', 'minimatch');
	await mkdir(nested, { recursive: true });
	await writeFile(path.join(nested, 'package.json'), '{"version":"10.2.4"}');
	assert.throws(() => patchLanguageClientGlobs(root), /Unreviewed.*minimatch.*10\.2\.4/);
	for (const [name, source] of contents) {
		assert.equal(await readFile(path.join(client, name), 'utf8'), source);
	}
});
