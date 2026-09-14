/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { discoverSystemCatalog, readCatalogSkill } from './SystemCatalog';

async function fixture(t: TestContext) {
	const root = await fs.mkdtemp(path.join(tmpdir(), 'sota-discovery-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const home = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
	const write = async (filename: string, content: string) => { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, content); };
	return { root, home, workspace, write, discover: () => discoverSystemCatalog({ home, workspace }) };
}

test('discovers skills across applications, deduplicates symlinks and reads bounded resources', async t => {
	const f = await fixture(t);
	const source = path.join(f.home, '.agents/skills/build');
	await f.write(path.join(source, 'SKILL.md'), '---\nname: Build\ndescription: >\n  Compile and verify\n  the project.\n---\nRead scripts/check.txt.');
	await f.write(path.join(source, 'scripts/check.txt'), 'safe bundled resource');
	await fs.mkdir(path.join(f.home, '.claude/skills'), { recursive: true });
	await fs.symlink(source, path.join(f.home, '.claude/skills/build'));
	await f.write(path.join(f.workspace, '.cursor/skills/review/SKILL.md'), '---\nname: Review\ndescription: Review code\n---\nReview.');
	const catalog = await f.discover();
	assert.deepEqual(catalog.entries.map(entry => [entry.name, entry.source, entry.scope]), [['Review', 'cursor', 'workspace'], ['Build', 'shared', 'user']]);
	const entry = catalog.entries.find(entry => entry.name === 'Build')!;
	assert.equal(await readCatalogSkill(catalog, entry.id, 'scripts/check.txt'), 'safe bundled resource');
	await f.write(path.join(f.home, 'private.txt'), 'secret');
	await fs.symlink(path.join(f.home, 'private.txt'), path.join(source, 'escape.txt'));
	await assert.rejects(readCatalogSkill(catalog, entry.id, 'escape.txt'), /inside/);
	await assert.rejects(readCatalogSkill(catalog, entry.id, '../../../private.txt'), /inside/);
});

test('parses TOML and JSONC MCP descriptors without leaking credentials into the catalog', async t => {
	const f = await fixture(t);
	await f.write(path.join(f.home, '.codex/config.toml'), '[mcp_servers.docs]\nurl = "https://example.test/mcp"\n[mcp_servers.docs.http_headers]\nAuthorization = "secret-fixture"\n[mcp_servers.disabled]\ncommand = "never-start"\nenabled = false\n');
	await f.write(path.join(f.workspace, '.cursor/mcp.json'), '{ // comments are supported\n"mcpServers": {"local": {"command": "node", "args": ["server.js"], "env": {"TOKEN": "private-fixture"}},},}');
	const catalog = await f.discover();
	assert.equal(catalog.servers.size, 2);
	assert.doesNotMatch(JSON.stringify(catalog.entries), /secret-fixture|private-fixture/);
	assert.equal(catalog.entries.find(entry => entry.name === 'disabled')?.enabled, false);
	assert.equal([...catalog.servers.values()].find(server => server.url)?.headers?.Authorization, 'secret-fixture');
	assert.equal([...catalog.servers.values()].find(server => server.command)?.cwd, f.workspace);
});

test('unresolved environment references and invalid configurations cannot become runnable servers', async t => {
	const f = await fixture(t);
	await f.write(path.join(f.home, '.cursor/mcp.json'), '{"mcpServers":{"needsEnv":{"command":"node","env":{"TOKEN":"${SOTA_NONEXISTENT_DISCOVERY_FIXTURE}"}},"badUrl":{"url":"file:///private"},"off":{"command":"node","disabled":true}}}');
	await f.write(path.join(f.home, '.codex/config.toml'), 'not valid = [');
	const catalog = await f.discover();
	assert.equal(catalog.servers.size, 0);
	assert.equal(catalog.entries.length, 3);
	assert.ok(catalog.entries.every(entry => entry.reason));
	assert.equal(catalog.issues.length, 1);
});

test('installed Claude plugins contribute skills and MCPs with root expansion and source disablement', async t => {
	const f = await fixture(t);
	const pluginRoot = path.join(f.home, '.claude/plugins/cache/vendor/review/1.0');
	await f.write(path.join(pluginRoot, '.claude-plugin/plugin.json'), '{"name":"review","version":"1.0","skills":"./skills"}');
	await f.write(path.join(pluginRoot, 'skills/review/SKILL.md'), '---\nname: Review Plugin\n---\nReview.');
	await f.write(path.join(pluginRoot, '.mcp.json'), '{"mcpServers":{"review":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.js"]}}}');
	await f.write(path.join(f.home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'review@vendor': [{ scope: 'user', installPath: pluginRoot }] } }));
	let catalog = await f.discover();
	assert.equal(catalog.entries.length, 3);
	assert.deepEqual([...catalog.servers.values()][0].args, [path.join(pluginRoot, 'server.js')]);
	await f.write(path.join(f.home, '.claude/settings.json'), '{"enabledPlugins":{"review@vendor":false}}');
	catalog = await f.discover();
	assert.equal(catalog.servers.size, 0);
	assert.ok(catalog.entries.every(entry => !entry.enabled));
});

test('Codex caches expose one version and do not activate plugins absent from configuration', async t => {
	const f = await fixture(t);
	for (const version of ['1.9.0', '1.10.0']) {
		const root = path.join(f.home, '.codex/plugins/cache/vendor/example', version);
		await f.write(path.join(root, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'example', version }));
		await f.write(path.join(root, 'skills/example/SKILL.md'), '---\nname: Example\n---\nExample.');
	}
	let catalog = await f.discover();
	assert.equal(catalog.entries.filter(entry => entry.kind === 'plugin').length, 1);
	assert.equal(catalog.entries[0].version, '1.10.0');
	assert.ok(catalog.entries.every(entry => !entry.enabled));
	await f.write(path.join(f.home, '.codex/config.toml'), '[plugins."example@vendor"]\nenabled = true\n');
	catalog = await f.discover();
	assert.ok(catalog.entries.every(entry => entry.enabled));
});

test('workspace plugin settings override user settings and nested skills remain discoverable', async t => {
	const f = await fixture(t);
	const root = path.join(f.home, '.claude/plugins/cache/vendor/nested/1');
	await f.write(path.join(root, '.claude-plugin/plugin.json'), '{"name":"nested"}');
	await f.write(path.join(root, 'skills/group/nested/SKILL.md'), '---\nname: Nested\n---\nNested skill.');
	await f.write(path.join(f.home, '.claude/plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'nested@vendor': [{ installPath: root }] } }));
	await f.write(path.join(f.home, '.claude/settings.json'), '{"enabledPlugins":{"nested@vendor":true}}');
	await f.write(path.join(f.workspace, '.claude/settings.local.json'), '{"enabledPlugins":{"nested@vendor":false}}');
	const catalog = await f.discover();
	assert.deepEqual(catalog.entries.map(entry => [entry.name, entry.enabled]), [['nested', false], ['Nested', false]]);
});

test('Claude Desktop and Cursor workspace variables yield usable private descriptors', async t => {
	const f = await fixture(t);
	await f.write(path.join(f.home, 'Library/Application Support/Claude/claude_desktop_config.json'), '{"mcpServers":{"desktop":{"command":"node"}}}');
	await f.write(path.join(f.workspace, '.cursor/mcp.json'), '{"mcpServers":{"workspace":{"command":"node","args":["${workspaceFolder}/server.js"],"env":{"OPTION":"${SOTA_ABSENT_FIXTURE:-default}"}}}}');
	const catalog = await f.discover();
	assert.equal(catalog.servers.size, 2);
	const workspace = [...catalog.servers.values()].find(server => server.cwd === f.workspace)!;
	assert.deepEqual([workspace.args, workspace.env], [[path.join(f.workspace, 'server.js')], { OPTION: 'default' }]);
});
