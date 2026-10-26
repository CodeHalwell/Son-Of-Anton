/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
for (const [directory, file] of [['build/codypendent/vendor', 'manifest.json'], ['extensions/son-of-anton-daemon/vendor', 'UPSTREAM.json']]) {
	const manifest = await json(`${directory}/${file}`);
	assert.equal(path.basename(manifest.archive), manifest.archive, 'Archive must be local to its vendor directory');
	const bytes = await readFile(path.join(root, directory, manifest.archive));
	assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.archiveSha256, `${directory} integrity`);
	assert.match(manifest.sourceSha256, /^[a-f0-9]{64}$/);
	assert.ok((await readFile(path.join(root, directory, 'LICENSE'))).length);
	if (manifest.integrity) {
		assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, manifest.integrity);
		for (const extension of ['son-of-anton', 'son-of-anton-daemon']) {
			const lock = await json(`extensions/${extension}/package-lock.json`);
			assert.equal(lock.packages[`node_modules/${manifest.package}`].integrity, manifest.integrity);
			assert.equal(lock.packages[`node_modules/${manifest.package}`].version, manifest.version);
		}
	}
}
console.log('Vendored Codypendent SDK and runtime source integrity verified.');
