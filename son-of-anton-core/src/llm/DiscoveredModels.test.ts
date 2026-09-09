/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveredAcpModelId, discoveredModelId, getDiscoveredModel, registerDiscoveredModels, type DiscoveredModel } from './DiscoveredModels';

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
