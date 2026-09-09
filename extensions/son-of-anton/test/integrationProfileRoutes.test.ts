/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { discoveredAcpModelId, discoveredModelId } from 'son-of-anton-core/llm/DiscoveredModels';
import { captureIntegrationRoutes, readProfiles } from '../src/integrations/IntegrationProfiles';
import { integrationProfileValue, registerSystemIntegrations } from '../src/integrations/SystemIntegrations';

suite('Integration profile route persistence', () => {
	test('long provider and ACP routes round-trip into effective trusted activation without catalog registration', async () => {
		const adapter = '适配/器'.repeat(150);
		const values = new Map<string, string>([
			['sota.agents.anton-code.model', discoveredModelId('openai', '\u0800'.repeat(512))],
			['sota.agents.anton-test.model', discoveredAcpModelId(adapter, `scope/${'é'.repeat(506)}`)],
			['sota.agents.anton-test.acpAgent', adapter],
			['sota.agents.anton-docs.model', discoveredAcpModelId('adapter/namespace', 'model/')],
			['sota.agents.anton-ci.model', discoveredAcpModelId('adapter/namespace', '/')],
			['sota.agents.anton-e2e.model', `  ${discoveredModelId('anthropic', 'm'.repeat(512))}  `],
			['sota.agents.anton-code.acpAgent', ''],
			['sota.agents.anton-docs.acpAgent', '   '],
			['sota.agents.anton-e2e.acpAgent', ` \t${adapter}  `],
			['sota.agents.anton.model', ''],
		]);
		const routes = captureIntegrationRoutes(key => values.get(key)); assert.deepEqual(routes, Object.fromEntries(values));
		const profile = { version: 1, activeId: 'long-routes', profiles: [{ id: 'long-routes', name: 'Long Routes', entryIds: [], routes, updatedAt: 1 }] };
		const workspace = path.resolve('profile-route-test'); const storageKey = `sota.integrationProfiles.v1.${createHash('sha256').update(workspace).digest('hex')}`;
		const persisted = new Map<string, string>();
		const workspaceState = { get: (key: string) => { const raw = persisted.get(key); return raw === undefined ? undefined : JSON.parse(raw); }, update: async (key: string, value: unknown) => { persisted.set(key, JSON.stringify(value)); } };
		await workspaceState.update(storageKey, profile); assert.deepEqual(readProfiles(workspaceState.get(storageKey)).profiles[0].routes, routes);
		const descriptors = Object.getOwnPropertyDescriptors(vscode.workspace); const subscriptions: vscode.Disposable[] = [];
		Object.assign(vscode.workspace, { isTrusted: true, workspaceFolders: [{ uri: { fsPath: workspace } }], getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'integrations.enabled' ? false : fallback }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) });
		try {
			registerSystemIntegrations({ workspaceState, subscriptions } as unknown as vscode.ExtensionContext, () => {}, new Map());
			for (const [key, value] of values) { assert.equal(integrationProfileValue(key), value, key); }
			Object.assign(vscode.workspace, { isTrusted: false });
			for (const key of values.keys()) { assert.equal(integrationProfileValue(key), undefined, 'Restricted Mode must not activate profile routes'); }
		} finally {
			for (const subscription of subscriptions) { subscription.dispose(); }
			for (const key of Object.keys(vscode.workspace)) { if (!descriptors[key]) { Reflect.deleteProperty(vscode.workspace, key); } }
			Object.defineProperties(vscode.workspace, descriptors);
		}
		assert.equal(integrationProfileValue('sota.agents.anton-code.model'), undefined);
	});

	test('shared capture and read validation reject malformed catalog routes while preserving existing alias bounds', () => {
		const invalidModels = [
			'alias'.repeat(41), `catalog:openai:${'x'.repeat(513)}`, `catalog:acp:${encodeURIComponent(`adapter/${'x'.repeat(513)}`)}`,
			'catalog:unknown:model', 'catalog:openai:%', 'catalog:openai:%GG', 'catalog:openai:%00', 'catalog:openai:unencoded/slash',
			'catalog:openai:%2f', 'catalog:openai:', 'catalog:acp:%20%20', 'catalog:acp:%ED%A0%80',
		];
		for (const model of invalidModels) {
			const key = 'sota.agents.anton-code.model';
			assert.deepEqual(captureIntegrationRoutes(candidate => candidate === key ? model : undefined), {}, model);
			assert.deepEqual(readProfiles({ version: 1, profiles: [{ id: 'one', name: 'One', entryIds: [], routes: { [key]: model } }] }).profiles[0].routes, {}, model);
		}
		for (const adapter of ['\u0000', 'adapter\ncommand', 'adapter\u007f']) {
			assert.deepEqual(captureIntegrationRoutes(key => key.endsWith('.acpAgent') ? adapter : undefined), {});
			assert.deepEqual(readProfiles({ version: 1, profiles: [{ id: 'one', name: 'One', entryIds: [], routes: { 'sota.agents.anton-code.acpAgent': adapter } }] }).profiles[0].routes, {});
		}
		const allowed = { 'sota.agents.anton-code.model': 'x'.repeat(200), 'sota.agents.anton-code.acpAgent': 'adapter'.repeat(1000) };
		assert.deepEqual(readProfiles({ version: 1, profiles: [{ id: 'one', name: 'One', entryIds: [], routes: { ...allowed, 'sota.mcp.trustedServers': 'not-allowed', 'sota.agents.anton-code.command': 'not-allowed' } }] }).profiles[0].routes, allowed);
	});

	test('ACP structural validation accepts slash-containing namespace and maximum encoded raw-model boundaries', () => {
		for (const [adapter, model] of [['adapter', '\u0800'.repeat(512)], ['adapter/namespace'.repeat(100), 'family/model'], ['adapter', 'model/'], ['adapter', '/'], ['adapter', `${'m'.repeat(511)}/`]]) {
			const value = discoveredAcpModelId(adapter, model); const key = 'sota.agents.anton-spec.model';
			const captured = captureIntegrationRoutes(candidate => candidate === key ? value : undefined);
			assert.equal(captured[key], value);
			assert.equal(readProfiles(JSON.parse(JSON.stringify({ version: 1, profiles: [{ id: 'one', name: 'One', entryIds: [], routes: captured }] }))).profiles[0].routes[key], value);
		}
	});
});
