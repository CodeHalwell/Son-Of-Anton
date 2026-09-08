/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointManager } from './CheckpointManager';
import type { ConfigStore, MementoStore } from '../host';

test('non-Git manager retains branch-linked checkpoints through parent deletion and count pruning', async t => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-checkpoint-manager-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'workspace'); await fs.mkdir(root); await fs.writeFile(join(root, 'file'), 'one');
	const values = new Map<string, unknown>(); const state: MementoStore = { get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T, update: async (key, value) => { values.set(key, value); } };
	const config: ConfigStore = { get: <T>(key: string, fallback?: T) => (key === 'checkpoints.maxCount' ? 1 : fallback) as T };
	const conversations = new Map([['parent', ['first', 'later']], ['branch', ['first', 'branch later']]]);
	const manager = new CheckpointManager({ load: id => { const messages = conversations.get(id); return messages ? { messages, summary: {} } : undefined; }, update: (id, messages) => { conversations.set(id, messages as string[]); } }, state, { storageRoot: join(directory, 'storage'), getWorkspaceRoot: () => root, config, confirmRestore: async () => true, notifier: { info() {}, warn(message) { assert.fail(message); }, error(message) { assert.fail(message); } } });
	t.after(() => manager.dispose());
	const checkpoint = await manager.capture('parent', 1, 'first'); assert.ok(checkpoint);
	await manager.attachToBranch(checkpoint.id, 'branch'); await manager.deleteFor('parent');
	await fs.writeFile(join(root, 'file'), 'two'); await manager.capture('other', 0, 'later'); await manager.capture('other', 1, 'latest');
	assert.equal(manager.list('branch')[0]?.id, checkpoint.id);
	await assert.rejects(manager.restore(checkpoint.id, { conversationToo: true, conversationId: 'unrelated' }), /not associated/);
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'two');
	await manager.restore(checkpoint.id, { conversationToo: true, conversationId: 'branch' });
	assert.deepEqual({ file: await fs.readFile(join(root, 'file'), 'utf8'), parent: conversations.get('parent'), branch: conversations.get('branch') }, { file: 'one', parent: ['first', 'later'], branch: ['first'] });
});
