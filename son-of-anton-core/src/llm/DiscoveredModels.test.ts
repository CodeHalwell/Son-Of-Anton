/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveredAcpModelId, discoveredModelId, getDiscoveredModel, onDiscoveredModelsChanged, registerDiscoveredModels, replaceDiscoveredModels, type DiscoveredModel } from './DiscoveredModels';

test('ACP catalog registration limits raw model IDs independently of adapter prefixes and URL encoding', () => {
	const acpAdapterId = 'adapter'.repeat(100);
	const model = 'é'.repeat(512);
	const id = discoveredAcpModelId(acpAdapterId, model);
	const entry: DiscoveredModel = { id, provider: 'acp', acpAdapterId, model, label: 'Long model', chat: true, images: false, tools: true, fetchedAt: 1 };
	registerDiscoveredModels([entry]);
	assert.deepEqual(getDiscoveredModel(id), entry);
	assert.equal(id, `catalog:acp:${encodeURIComponent(`${acpAdapterId}/${model}`)}`);
	assert.equal(discoveredAcpModelId('adapter', 'short/model'), discoveredModelId('acp', 'adapter/short/model'));
});

test('ACP catalogs reject invalid raw model IDs even when cached entries bypass the ID helper', () => {
	for (const model of ['x'.repeat(513), 'invalid\nmodel', '   ']) {
		assert.throws(() => discoveredAcpModelId('invalid-catalog-fixture', model), /Invalid ACP model identifier/);
		const id = `catalog:acp:${encodeURIComponent(`invalid-catalog-fixture/${model}`)}` as const;
		registerDiscoveredModels([{ id, provider: 'acp', acpAdapterId: 'invalid-catalog-fixture', model, label: 'Invalid model', chat: true, images: false, tools: true, fetchedAt: 1 }]);
		assert.equal(getDiscoveredModel(id), undefined);
	}
	assert.doesNotThrow(() => discoveredModelId('openai', 'x'.repeat(512)));
	assert.throws(() => discoveredModelId('openai', 'x'.repeat(513)), /Invalid provider model identifier/);
});

test('authoritative replacement removes omitted models atomically and retains other providers and verified capabilities', t => {
	const model = (name: string): DiscoveredModel => ({ id: discoveredModelId('cerebras', name), provider: 'cerebras', model: name, label: name, chat: true, images: 'unknown', tools: 'unknown', fetchedAt: 1 });
	const removed = model('removed'), retained = { ...model('retained'), tools: true as const, capabilitySource: 'verified' as const, verifiedAt: Date.now() };
	const other: DiscoveredModel = { ...model('unrelated'), id: discoveredModelId('groq', 'unrelated'), provider: 'groq' };
	registerDiscoveredModels([removed, retained, other]);
	const observations: Array<Array<string | undefined>> = [];
	const listener = onDiscoveredModelsChanged(() => observations.push([getDiscoveredModel(removed.id)?.id, getDiscoveredModel(retained.id)?.id]));
	t.after(() => listener.dispose());
	replaceDiscoveredModels({ provider: 'cerebras' }, [model('retained')]);
	assert.deepEqual(observations, [[undefined, retained.id]]);
	assert.equal(getDiscoveredModel(retained.id)?.tools, true);
	assert.equal(getDiscoveredModel(retained.id)?.verifiedAt, retained.verifiedAt);
	assert.deepEqual(getDiscoveredModel(other.id), other);
	assert.throws(() => replaceDiscoveredModels({ provider: 'cerebras' }, [other]), /unrelated entry/);
	assert.equal(getDiscoveredModel(retained.id)?.id, retained.id);
	replaceDiscoveredModels({ provider: 'cerebras' }, []);
	assert.equal(getDiscoveredModel(retained.id), undefined);
	assert.deepEqual(getDiscoveredModel(other.id), other);
});

test('ACP replacement owns exactly one adapter, including successful empty advertisements', () => {
	const entry = (acpAdapterId: string, model: string): DiscoveredModel => ({ id: discoveredAcpModelId(acpAdapterId, model), provider: 'acp', acpAdapterId, model, label: model, chat: true, images: false, tools: true, fetchedAt: 1 });
	const first = entry('replacement-first', 'same-model'), second = entry('replacement-second', 'same-model');
	registerDiscoveredModels([first, second]);
	replaceDiscoveredModels({ provider: 'acp', acpAdapterId: 'replacement-first' }, []);
	assert.equal(getDiscoveredModel(first.id), undefined);
	assert.deepEqual(getDiscoveredModel(second.id), second);
	assert.throws(() => replaceDiscoveredModels({ provider: 'acp', acpAdapterId: 'replacement-second' }, [first]), /unrelated entry/);
	assert.deepEqual(getDiscoveredModel(second.id), second);
});
