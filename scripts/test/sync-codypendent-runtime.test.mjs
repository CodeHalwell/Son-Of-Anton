/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';
import { syncCodypendentRuntime } from '../sync-codypendent-runtime.mjs';

test('runtime source archives include cross-root Rust contracts without collecting local configuration', async t => {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-runtime-source-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = path.join(root, 'source');
	await mkdir(source);
	const files = {
		'Cargo.toml': '[workspace.package]\nversion = "1.2.3"\n',
		'Cargo.lock': '# locked fixture\n',
		'LICENSE': 'fixture license',
		'crates/integrations/src/lib.rs': 'const CONTRACT: &str = include_str!("../../../testdata/failure-sanitization.json");',
		'crates/integrations/tests/lifecycle.rs': 'const CONTRACT: &str = include_str!("../../../testdata/acp-tool-lifecycle.json");',
		'crates/sandbox/src/verify.rs': 'const CONTRACT: &str = include_str!("../../../sdk/ui/test/fixtures/signing-plugin.toml");',
		'testdata/failure-sanitization.json': '{"keys":["fixture-key"]}',
		'testdata/acp-tool-lifecycle.json': '{"lifecycle":"fixture"}',
		'sdk/ui/test/fixtures/signing-plugin.toml': 'name = "fixture"\n',
		'.env': 'LOCAL_CONFIGURATION=never-vendor',
		'testdata/private.json': '{"local":"never-vendor"}',
		'sdk/ui/test/fixtures/local-config.json': '{"local":"never-vendor"}',
	};
	for (const [name, contents] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(source, name)), { recursive: true });
		await writeFile(path.join(source, name), contents);
	}
	const git = (...args) => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
	git('init'); git('add', '.');
	git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-gpg-sign', '-m', 'fixture');
	const destination = path.join(root, 'vendor');
	await syncCodypendentRuntime(source, destination);
	const names = [];
	await tar.t({ file: path.join(destination, 'codypendent-source.tar.gz'), onReadEntry: entry => names.push(entry.path) });
	assert.deepEqual(names, Object.keys(files).filter(name => !['.env', 'testdata/private.json', 'sdk/ui/test/fixtures/local-config.json'].includes(name)).sort());
	const extracted = path.join(root, 'extracted');
	await mkdir(extracted);
	await tar.x({ cwd: extracted, file: path.join(destination, 'codypendent-source.tar.gz') });
	for (const name of ['testdata/failure-sanitization.json', 'testdata/acp-tool-lifecycle.json', 'sdk/ui/test/fixtures/signing-plugin.toml']) {
		assert.equal(await readFile(path.join(extracted, name), 'utf8'), files[name]);
	}
	const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
	assert.equal(manifest.files, names.length);
});
