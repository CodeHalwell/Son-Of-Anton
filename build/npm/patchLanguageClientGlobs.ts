/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const extensions = new Set(['css-language-features', 'html-language-features', 'json-language-features', 'markdown-language-features']);
const nextFiles = [
	{ file: 'lib/common/fileOperations.js', original: '27021d92f7e2bb0094f0044d9516bfb3d76427e350b9a0945dac00e294f88f01', patched: '46f1ec30d94ec7f7658ff219d4f00f973c9629f648ebbf81e311022f8e7ff02d' },
	{ file: 'lib/common/utils/globPattern.js', original: 'ec8f8ed49366dc71c63a6908f0de06568086058cef3e59d6665df4c721826129', patched: '6bab870a3edd1d991af511e2e808afbaac10e236cb36422716b551403db75b7b' },
];
const versions: Record<string, typeof nextFiles> = {
	'10.0.0-next.18': nextFiles,
	'10.0.0-next.20': nextFiles,
	'8.0.2': [
		{ file: 'lib/common/fileOperations.js', original: 'b95ffe45498a2a1cc0fe8c5cc224970d96d2b6835b59706dbaf75795ddedfdb0', patched: '8aa1fbf298706bfeb5702501c38fa0ce765e2db77b431220700bc00406a98049' },
		{ file: 'lib/common/notebook.js', original: '1cf8a881116aa03119cadf3dd90ee31bcbbfcbc4589c2287196114b1212d8f29', patched: '9c1947c1ccea6473fb72d8b5f839ac082092e4fd77bc0a2bf48f99f33785adad' },
		{ file: 'lib/common/diagnostic.js', original: '8821c49fcd89fc70700f495bdf7c522ff272c34abec2d28da34e1d8d26f50b33', patched: 'cfcbdc84f55b91d9f8c328861286cc77e20b6f81f867690cf5b6b2797c2fb868' },
	],
};

/** Adapt only reviewed language-client validation guards to minimatch 11's bounded matcher. */
export function patchLanguageClientGlobs(extensionDirectory: string): void {
	if (!extensions.has(path.basename(extensionDirectory))) {
		return;
	}
	const client = path.join(extensionDirectory, 'node_modules', 'vscode-languageclient');
	const manifest = JSON.parse(readFileSync(path.join(client, 'package.json'), 'utf8')) as { version: string };
	const files = Object.hasOwn(versions, manifest.version) ? versions[manifest.version] : undefined;
	if (!files) {
		throw new Error(`Unreviewed language client glob compatibility version: ${manifest.version}`);
	}
	const matcherManifest = createRequire(path.join(client, 'package.json')).resolve('minimatch/package.json');
	const matcher = JSON.parse(readFileSync(matcherManifest, 'utf8')) as { version: string };
	if (matcher.version !== '11.0.1') {
		throw new Error(`Unreviewed language client minimatch compatibility version: ${matcher.version}`);
	}
	const changes: { filename: string; content: string; original: string; patched: string }[] = [];
	for (const file of files) {
		const filename = path.join(client, file.file);
		if (!lstatSync(filename).isFile()) {
			throw new Error(`Language client glob compatibility requires a regular file: ${filename}`);
		}
		const content = readFileSync(filename, 'utf8');
		const digest = createHash('sha256').update(content).digest('hex');
		if (digest === file.patched) {
			continue;
		}
		if (digest !== file.original || content.split('!matcher.makeRe()').length !== 2) {
			throw new Error(`Unreviewed language client glob compatibility source: ${filename}`);
		}
		const patched = content.replace('!matcher.makeRe()', 'matcher.set.length === 0');
		if (createHash('sha256').update(patched).digest('hex') !== file.patched) {
			throw new Error(`Language client glob compatibility integrity mismatch: ${filename}`);
		}
		changes.push({ filename, content: patched, original: file.original, patched: file.patched });
	}
	// Validate every input before writing any patch; known patched states are idempotent.
	for (const change of changes) {
		const current = createHash('sha256').update(readFileSync(change.filename)).digest('hex');
		if (current === change.patched) {
			continue;
		}
		if (current !== change.original) {
			throw new Error(`Language client glob compatibility source changed: ${change.filename}`);
		}
		const temporary = `${change.filename}.sota-globs-${randomUUID()}`;
		try {
			writeFileSync(temporary, change.content, { flag: 'wx', mode: 0o644 });
			renameSync(temporary, change.filename);
		} finally {
			rmSync(temporary, { force: true });
		}
	}
}
