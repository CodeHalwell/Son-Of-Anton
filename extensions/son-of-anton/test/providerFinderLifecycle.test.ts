/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ProviderFinder } from '../src/providers/ProviderFinder';
import { MODEL_METADATA } from 'son-of-anton-core/llm/modelMetadata';
import type { ProviderDiscoverySnapshot } from 'son-of-anton-core/llm/ProviderDiscovery';
import type { DiscoveredModel } from 'son-of-anton-core/llm/DiscoveredModels';

suite('Provider Finder catalog lifecycle', () => {
	test('credential removal clears catalog metadata and picker entries while error-retained and static models survive', async () => {
		const removed: DiscoveredModel = { id: 'catalog:openai:removed-credential', provider: 'openai', model: 'removed-credential', label: 'Removed credential model', chat: true, images: 'unknown', tools: 'unknown', fetchedAt: 1 };
		const retained: DiscoveredModel = { ...removed, id: 'catalog:anthropic:retained-error', provider: 'anthropic', model: 'retained-error', label: 'Retained after error' };
		const snapshot: ProviderDiscoverySnapshot = { version: 1, updatedAt: 1, software: [], providers: [
			{ id: 'openai', name: 'OpenAI', credentialSource: 'setting', catalogStatus: 'ready', inferenceStatus: 'not-tested', models: [removed] },
			{ id: 'anthropic', name: 'Anthropic', credentialSource: 'broker', catalogStatus: 'ready', inferenceStatus: 'not-tested', models: [retained] },
		] };
		const metadata = { ...MODEL_METADATA }; const withProgress = vscode.window.withProgress; const showQuickPick = vscode.window.showQuickPick;
		const finder = Object.assign(Object.create(ProviderFinder.prototype), { refresh: async () => snapshot }) as {
			registerMetadata(value: ProviderDiscoverySnapshot): void;
			showPicker(): Promise<void>;
		};
		let items: Array<vscode.QuickPickItem & { modelId?: string; setup?: string }> = [];
		try {
			finder.registerMetadata(snapshot); assert.ok(MODEL_METADATA[removed.id]);
			for (const state of [{ catalogStatus: 'error' }, { catalogStatus: 'ready', truncated: true }, { catalogStatus: 'not-configured', credentialSource: 'none' }]) {
				const partial = structuredClone(snapshot); Object.assign(partial.providers[0], { models: [], ...state });
				finder.registerMetadata(partial); assert.ok(MODEL_METADATA[removed.id], 'Incomplete evidence must not retire cached metadata');
			}
			Object.assign(snapshot.providers[0], { credentialSource: 'none', credentialStatus: 'missing', catalogStatus: 'not-configured', models: [] });
			Object.assign(snapshot.providers[1], { credentialSource: 'none', catalogStatus: 'error', error: 'Temporary broker failure' });
			finder.registerMetadata(snapshot);
			Object.assign(vscode.window, {
				withProgress: async (_options: object, task: () => Promise<ProviderDiscoverySnapshot>) => task(),
				showQuickPick: async (choices: typeof items) => { items = choices; return undefined; },
			});
			await finder.showPicker();
			assert.deepEqual({ removed: MODEL_METADATA[removed.id], retained: MODEL_METADATA[retained.id]?.discovered, staticModel: MODEL_METADATA.sonnet, pickerModels: items.filter(item => item.modelId).map(item => item.modelId), setup: items.find(item => item.setup === 'openai')?.description }, { removed: undefined, retained: true, staticModel: metadata.sonnet, pickerModels: [retained.id], setup: 'not-configured' });
		} finally {
			Object.assign(vscode.window, { withProgress, showQuickPick });
			for (const id of Object.keys(MODEL_METADATA)) { delete MODEL_METADATA[id as keyof typeof MODEL_METADATA]; }
			Object.assign(MODEL_METADATA, metadata);
		}
	});
});
