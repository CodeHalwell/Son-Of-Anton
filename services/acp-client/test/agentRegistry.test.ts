/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRegistry } from '../src/registry/agentRegistry';
const entry = { id: 'fixture', name: 'Fixture', transport: 'stdio', command: process.execPath, args: [], capabilities: ['analysis'], costTier: 'local', env: { SYNTHETIC_SECRET: 'never-describe-this' } };

test('registry exposes descriptors without commands or environment secrets and prevents external mutation', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'acp-registry-')); t.after(() => rm(dir, { recursive: true, force: true }));
	const config = path.join(dir, 'agents.json'); await writeFile(config, JSON.stringify({ agents: [entry] }));
	const registry = new AgentRegistry(config); await registry.load();
	const descriptions = registry.listDescriptors(); descriptions[0].capabilities.push('testing');
	registry.getEntry('fixture')!.env!.SYNTHETIC_SECRET = 'mutated';
	assert.deepEqual([registry.listDescriptors()[0].capabilities, registry.getEntry('fixture')?.env?.SYNTHETIC_SECRET], [['analysis'], 'never-describe-this']);
	assert.equal(JSON.stringify(descriptions).includes('never-describe-this'), false);
});
test('invalid registry reloads preserve the entire previous valid configuration', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'acp-registry-')); t.after(() => rm(dir, { recursive: true, force: true }));
	const config = path.join(dir, 'agents.json'); const registry = new AgentRegistry(config);
	await writeFile(config, JSON.stringify({ agents: [entry] })); await registry.load();
	for (const agents of [[entry, { ...entry, id: 'bad', command: '' }], [entry, entry], [{ ...entry, transport: 'http', url: 'http://localhost' }]]) {
		await writeFile(config, JSON.stringify({ agents })); await assert.rejects(registry.load());
		assert.deepEqual(registry.listDescriptors().map(agent => agent.id), ['fixture']);
	}
});
test('missing configuration is explicitly empty', async () => {
	const registry = new AgentRegistry('/nonexistent/sota-acp/agents.json'); await registry.load();
	assert.deepEqual(registry.listDescriptors(), []);
});
