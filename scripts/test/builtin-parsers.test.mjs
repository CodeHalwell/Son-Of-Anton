/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { getImageSize } from '../../extensions/emmet/src/imageSizeHelper.ts';

const dependency = name => createRequire(new URL(`../../extensions/${name}/package.json`, import.meta.url));

async function loadClientModule(extension, relativePath, { vscode = {}, modules = {}, expose = '', transform = source => source } = {}) {
	const extensionRequire = dependency(extension);
	const commonDirectory = path.resolve(path.dirname(extensionRequire.resolve('vscode-languageclient')), '../common');
	const filename = path.join(commonDirectory, relativePath);
	const clientRequire = createRequire(filename);
	const exports = {};
	vm.runInNewContext(`${transform(await readFile(filename, 'utf8'))}\n${expose}`, {
		exports,
		require: name => {
			if (name === 'vscode') { return vscode; }
			if (Object.hasOwn(modules, name)) { return modules[name]; }
			return clientRequire(name);
		}
	});
	return exports;
}

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

test('npm task exclusions retain dot, brace, globstar, and multiple-pattern matching', async () => {
	const filename = new URL('../../extensions/npm/out/tasks.js', import.meta.url);
	const taskRequire = createRequire(filename);
	let exclude;
	const exports = {};
	vm.runInNewContext(`${await readFile(filename, 'utf8')}\nexports.testIsExcluded = isExcluded;`, {
		exports,
		require: name => {
			if (name === 'vscode') {
				return { workspace: { getConfiguration: () => ({ get: () => exclude }) } };
			}
			if (name.startsWith('./')) { return {}; }
			return taskRequire(name);
		}
	});
	const folder = { uri: {} };
	const matches = file => exports.testIsExcluded(folder, { fsPath: file });
	exclude = '**/{private,generated}/**';
	assert.deepEqual([
		matches('workspace/.cache/private/nested/package.json'),
		matches('workspace/generated/nested/package.json'),
		matches('workspace/public/package.json')
	], [true, true, false]);
	exclude = ['**/unused/**', '**/packages/?pp'];
	assert.deepEqual([
		matches('workspace/packages/app/package.json'),
		matches('workspace/packages/other/package.json')
	], [true, false]);
	exclude = undefined;
	assert.equal(matches('workspace/packages/app/package.json'), false);
});

for (const extension of ['css-language-features', 'html-language-features', 'json-language-features', 'markdown-language-features']) {
	test(`${extension} file-operation filters use the patched glob constructor`, async () => {
		const exports = await loadClientModule(extension, 'fileOperations.js', {
			vscode: { workspace: { onDidCreateFiles: () => ({ dispose() {} }) } }
		});
		const feature = new exports.DidCreateFilesFeature({ code2ProtocolConverter: { asDidCreateFilesParams: value => value } });
		feature.register({ id: 'fixture', registerOptions: { filters: [{ scheme: 'file', pattern: { glob: '**/{src,lib}/**/*.ts', options: { ignoreCase: true } } }] } });
		const files = [
			{ scheme: 'file', fsPath: '/workspace/src/nested/example.TS' },
			{ scheme: 'file', fsPath: '/workspace/lib/example.ts' },
			{ scheme: 'file', fsPath: '/workspace/test/example.ts' },
			{ scheme: 'untitled', fsPath: '/workspace/src/example.ts' }
		];
		const filtered = await feature.filter({ files }, uri => uri);
		assert.deepEqual(Array.from(filtered.files, uri => uri.fsPath), ['/workspace/src/nested/example.TS', '/workspace/lib/example.ts']);
		for (const glob of ['', '#comment']) {
			assert.throws(() => feature.register({ id: 'invalid', registerOptions: { filters: [{ pattern: { glob } }] } }), /Invalid pattern/);
		}
		feature.unregister('fixture');
		assert.deepEqual(Array.from((await feature.filter({ files }, uri => uri)).files), []);
		feature.register({ id: 'literal', registerOptions: { filters: [{ pattern: { glob: '**/literal/[' } }] } });
		const literal = { scheme: 'file', fsPath: '/workspace/literal/[' };
		assert.deepEqual(Array.from((await feature.filter({ files: [literal] }, uri => uri)).files), [literal]);
		feature.unregister('literal');
		assert.throws(() => feature.register({ id: 'too-long', registerOptions: { filters: [{ pattern: { glob: 'a'.repeat(65537) } }] } }), /pattern is too long/);
		feature.register({ id: 'bounded', registerOptions: { filters: [{ pattern: { glob: `**/${'*a'.repeat(500)}b` } }] } });
		assert.deepEqual(Array.from((await feature.filter({ files: [{ scheme: 'file', fsPath: `/workspace/${'a'.repeat(500)}c` }] }, uri => uri)).files), []);
		feature.unregister('bounded');
	});
}

for (const extension of ['css-language-features', 'html-language-features', 'json-language-features']) {
	test(`${extension} glob filters retain noext and invalid-pattern behavior`, async () => {
		const { matchGlobPattern } = await loadClientModule(extension, 'utils/globPattern.js');
		assert.deepEqual([
			matchGlobPattern('**/*.{css,scss}', { fsPath: '/workspace/src/example.css' }),
			matchGlobPattern('**/*.{css,scss}', { fsPath: '/workspace/lib/example.scss' }),
			matchGlobPattern('**/*.{css,scss}', { fsPath: '/workspace/src/example.css.map' }),
			matchGlobPattern('**/+(src|lib)/*.css', { fsPath: '/workspace/+(src|lib)/example.css' }),
			matchGlobPattern('**/+(src|lib)/*.css', { fsPath: '/workspace/src/example.css' }),
			matchGlobPattern('', { fsPath: '/workspace/src/example.css' }),
			matchGlobPattern('#comment', { fsPath: '/workspace/src/example.css' })
		], [true, true, false, true, false, false, false]);
	});
}

test('Markdown notebook filters retain type, scheme, glob, and empty-pattern checks', async () => {
	const { testMatchNotebook } = await loadClientModule('markdown-language-features', 'notebook.js', {
		expose: 'exports.testMatchNotebook = $NotebookDocumentFilter.matchNotebook;'
	});
	const document = { notebookType: 'jupyter', uri: { scheme: 'file', fsPath: '/workspace/notebooks/example.ipynb' } };
	assert.deepEqual([
		testMatchNotebook({ notebookType: 'jupyter', scheme: 'file', pattern: '**/*.{ipynb,md}' }, document),
		testMatchNotebook({ notebookType: 'other', pattern: '**/*.ipynb' }, document),
		testMatchNotebook({ scheme: 'untitled', pattern: '**/*.ipynb' }, document),
		testMatchNotebook({ pattern: '**/*.md' }, document),
		testMatchNotebook({ pattern: '' }, document),
		testMatchNotebook({ pattern: '#comment' }, document)
	], [true, false, false, false, false, false]);
});

test('Markdown diagnostic resource filters retain scheme, glob, and empty-pattern checks', async () => {
	const exports = await loadClientModule('markdown-language-features', 'diagnostic.js', {
		modules: { './features': { TextDocumentLanguageFeature: class {} } },
		expose: 'exports.testProvider = DiagnosticFeatureProviderImpl;',
		transform: source => {
			// Expose the real predicate before unrelated diagnostic subscriptions are installed.
			const marker = '\n        const matches = (document) => {';
			assert.equal(source.split(marker).length, 2);
			return source.replace(marker, `\n        exports.testMatchResource = matchResource;\n        return;${marker}`);
		}
	});
	const client = { clientOptions: { diagnosticPullOptions: {} }, protocol2CodeConverter: { asDocumentSelector: value => value } };
	const resource = { scheme: 'file', fsPath: '/workspace/src/example.md' };
	const matches = filter => {
		new exports.testProvider(client, {}, { documentSelector: [filter] });
		return exports.testMatchResource(resource);
	};
	assert.deepEqual([
		matches({ scheme: 'file', pattern: '**/*.{md,txt}' }),
		matches({ scheme: 'untitled', pattern: '**/*.md' }),
		matches({ pattern: '**/*.txt' }),
		matches({ pattern: '' }),
		matches({ pattern: '#comment' })
	], [true, false, false, false, false]);
});
