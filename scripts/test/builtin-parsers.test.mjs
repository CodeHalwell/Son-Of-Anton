/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getImageSize } from '../../extensions/emmet/src/imageSizeHelper.ts';

const dependency = name => createRequire(new URL(`../../extensions/${name}/package.json`, import.meta.url));

test('Emmet reads local retina images and embedded image data with the patched parser', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'sota-image-parser-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const image = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"></svg>';
	const file = path.join(directory, 'icon@2x.svg'); await writeFile(file, image);
	assert.deepEqual(await getImageSize(file), { realWidth: 8, realHeight: 6, width: 4, height: 3 });
	assert.deepEqual(await getImageSize(`data:image/svg+xml;base64,${Buffer.from(image).toString('base64')}`), { realWidth: 8, realHeight: 6, width: 8, height: 6 });
	await assert.rejects(getImageSize(path.join(directory, 'missing.png')));
});

test('the Git image detector retains PNG MIME detection', async () => {
	const { fileTypeFromBuffer } = dependency('git')('file-type');
	const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYv8AAAAASUVORK5CYII=', 'base64');
	assert.equal((await fileTypeFromBuffer(image))?.mime, 'image/png');
});

test('Markdown and the math plugin render together with patched KaTeX', () => {
	const MarkdownIt = dependency('markdown-language-features')('markdown-it');
	const pluginModule = dependency('markdown-math')('@vscode/markdown-it-katex');
	const markdown = new MarkdownIt().use(pluginModule.default ?? pluginModule);
	const result = markdown.render('# Heading\n\n$E = mc^2$\n\n[Example](https://example.com)');
	assert.match(result, /<h1>Heading<\/h1>/);
	assert.match(result, /class="katex"/);
	assert.match(result, /href="https:\/\/example.com"/);
});

test('Markdown sanitization removes active HTML while retaining ordinary content', () => {
	const { JSDOM } = dependency('son-of-anton-daemon')('jsdom');
	const { window } = new JSDOM('');
	try {
		const purify = dependency('markdown-language-features')('dompurify')(window);
		const clean = purify.sanitize('<p>Keep</p><img src=x onerror="bad()"><script>bad()</script><a href="javascript:bad()">Link</a>');
		assert.match(clean, /<p>Keep<\/p>/);
		assert.doesNotMatch(clean, /onerror|<script|javascript:/i);
	} finally { window.close(); }
});

test('Microsoft authentication generates correlation IDs with the patched UUID dependency', () => {
	const { CryptoProvider } = dependency('microsoft-authentication')('@azure/msal-node');
	const crypto = new CryptoProvider(), first = crypto.createNewGuid(), second = crypto.createNewGuid();
	assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.notEqual(first, second);
});
