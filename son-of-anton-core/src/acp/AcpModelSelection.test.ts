/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpConnection } from './AcpConnection';
import { AcpRuntime, type AcpTurn } from './AcpRuntime';
import { AcpSessionStore } from './AcpSessionStore';
import { object } from './protocol';
import { discoveredAcpModelId, getDiscoveredModel, registerDiscoveredModels } from '../llm/DiscoveredModels';

async function fixture(t: TestContext, rows: unknown[], modelId: string) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'sota-acp-model-selection-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const catalog = path.join(directory, 'models.json');
	await writeFile(catalog, JSON.stringify(rows));
	return {
		id: path.basename(directory), command: process.execPath, args: [path.resolve(__dirname, '../../test/fixtures/acp-agent.cjs')], modelId,
		env: { FIXTURE_MODEL_ROWS_FILE: catalog, FIXTURE_SESSIONS_FILE: path.join(directory, 'sessions.json') },
	};
}
function output() {
	let text = '';
	return {
		onUpdate: (update: Parameters<NonNullable<AcpTurn['onUpdate']>>[0]) => { if (object(update.content) && typeof update.content.text === 'string') { text += update.content.text; } },
		get: (): { count: number; model: string } => JSON.parse(text.replace(/ 😀$/, '')),
	};
}
const models = (count: number) => Array.from({ length: count }, (_, index) => ({ modelId: `model-${index}`, name: `Model ${index}` }));

test('new ACP sessions select models on either side of the 500-entry discovery boundary', async t => {
	const rows = models(501); const longModel = 'm'.repeat(512);
	rows.push({ modelId: longModel, name: 'Last model' });
	const definition = await fixture(t, rows, 'model-499');
	const runtime = new AcpRuntime(); t.after(() => runtime.shutdown());
	const retainedId = discoveredAcpModelId(definition.id, 'previously-discovered');
	registerDiscoveredModels([{ id: retainedId, provider: 'acp', acpAdapterId: definition.id, model: 'previously-discovered', label: 'Previous', chat: true, tools: true, images: false, fetchedAt: 1 }]);
	for (const modelId of ['model-499', 'model-500', longModel]) {
		const agent = { ...definition, modelId }; const result = output();
		await runtime.run({ agent, cwd: process.cwd(), conversationId: 'boundary', text: 'hello', onUpdate: result.onUpdate });
		assert.equal(result.get().model, modelId);
		assert.deepEqual(runtime.getCapabilities(agent).models?.map(model => model.id), rows.slice(0, 500).map(model => model.modelId));
		assert.ok(getDiscoveredModel(retainedId), 'A truncated advertisement must not retire models outside its exposed inventory');
	}
	assert.equal(getDiscoveredModel(discoveredAcpModelId(definition.id, longModel)), undefined, 'Selecting an omitted model does not expand the bounded inventory');
});

test('loading a settled ACP session selects a model beyond the exposed catalog without falling back to a new session', async t => {
	const definition = await fixture(t, models(502), 'model-501');
	const state = new Map<string, unknown>();
	const sessionStore = new AcpSessionStore({ get: <T>(key: string) => state.get(key) as T | undefined, update: async (key, value) => { state.set(key, structuredClone(value)); } });
	const turn = { agent: definition, cwd: process.cwd(), conversationId: 'resume-beyond-limit', text: 'hello' };
	const first = new AcpRuntime({ sessionStore }); t.after(() => first.shutdown());
	await first.run(turn); await first.shutdown();
	const second = new AcpRuntime({ sessionStore }); t.after(() => second.shutdown());
	const result = output(); const recovery: string[] = [];
	await second.run({ ...turn, onUpdate: result.onUpdate, onRecovery: value => recovery.push(value) });
	assert.deepEqual([result.get().count, result.get().model, recovery], [2, 'model-501', ['resumed']]);
	assert.equal(second.getCapabilities(definition).models?.length, 500);
});

test('model inventory counts valid unique IDs, ignores malformed rows, and bounds display names', async t => {
	const rows: unknown[] = [
		null, 42, {}, { modelId: 'missing-name' }, { modelId: 'wrong-name', name: 42 },
		...['', ' ', 'bad\nmodel', 'x'.repeat(513)].map(modelId => ({ modelId, name: 'Invalid ID' })),
		{ modelId: 'model-0', name: 'N'.repeat(2000) },
		...Array.from({ length: 600 }, () => ({ modelId: 'model-0', name: 'Duplicate' })),
		...models(500),
	];
	const definition = await fixture(t, rows, 'model-499');
	const connection = new AcpConnection(definition, process.cwd()); t.after(() => connection.stop());
	await connection.newSession();
	assert.equal(connection.modelsAdvertised, true);
	assert.equal(connection.modelsTruncated, false, 'Invalid or duplicate rows do not omit any selectable unique model');
	assert.deepEqual(connection.availableModels.map(model => model.id), models(500).map(model => model.modelId));
	assert.equal(connection.availableModels[0].name, 'N'.repeat(200));
	const result = output();
	await connection.prompt('hello', { signal: new AbortController().signal, update: result.onUpdate });
	assert.equal(result.get().model, 'model-499');
});

test('a selected ID beyond the cap still needs a valid model row, and omitted valid rows flag truncation', async t => {
	const definition = await fixture(t, [...models(501), { modelId: 'invalid-row', name: null }, { modelId: 'x'.repeat(513), name: 'Oversized ID' }], 'invalid-row');
	const connection = new AcpConnection(definition, process.cwd()); t.after(() => connection.stop());
	await assert.rejects(connection.newSession(), /does not advertise the selected model/);
	assert.equal(connection.modelsTruncated, true);
	assert.equal(connection.availableModels.length, 500);
	assert.ok(connection.availableModels.every(model => model.id !== 'invalid-row'));
});
