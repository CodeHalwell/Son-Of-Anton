/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { dirname, join } from 'node:path';
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

test('checkpoint capture and history use one index when Windows host path casing differs from native realpath', async t => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-checkpoint-casing-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'workspace'); await fs.mkdir(root); await fs.writeFile(join(root, 'file'), 'one');
	const canonicalRoot = await fs.realpath(root);
	const hostRoot = join(dirname(canonicalRoot), 'WORKSPACE');
	assert.notEqual(hostRoot, canonicalRoot);
	const nativeRealpath = syncFs.realpathSync.native, legacyRealpath = syncFs.realpathSync, asyncRealpath = fs.realpath;
	// Reproduce Windows resolution on every platform: the legacy JS resolver
	// preserves the input spelling; the native sync/async resolvers canonicalize it.
	t.mock.method(syncFs.realpathSync, 'native', (...args: Parameters<typeof nativeRealpath>) => nativeRealpath(args[0] === hostRoot ? canonicalRoot : args[0], args[1]));
	t.mock.method(syncFs, 'realpathSync', (...args: Parameters<typeof legacyRealpath>) => args[0] === hostRoot ? hostRoot : legacyRealpath(...args));
	t.mock.method(fs, 'realpath', (...args: Parameters<typeof asyncRealpath>) => asyncRealpath(args[0] === hostRoot ? canonicalRoot : args[0], args[1]));
	assert.equal(syncFs.realpathSync(hostRoot), hostRoot);
	assert.equal(syncFs.realpathSync.native(hostRoot), canonicalRoot);
	assert.equal(await fs.realpath(hostRoot), canonicalRoot);
	const values = new Map<string, unknown>(); const state: MementoStore = { get: <T>(key: string, fallback?: T) => (values.get(key) ?? fallback) as T, update: async (key, value) => { values.set(key, value); } };
	const config: ConfigStore = { get: <T>(_key: string, fallback?: T) => fallback as T };
	let workspaceRoot = hostRoot;
	const host = { storageRoot: join(directory, 'storage'), getWorkspaceRoot: () => workspaceRoot, config, confirmRestore: async () => true, notifier: { info() {}, warn(message: string) { assert.fail(message); }, error(message: string) { assert.fail(message); } } };
	const conversations = { load: () => ({ messages: [], summary: {} }), update() {} };
	const manager = new CheckpointManager(conversations, state, host); t.after(() => manager.dispose());
	const checkpoint = await manager.capture('parent', 0, 'first'); assert.ok(checkpoint);
	assert.equal(checkpoint.fileSnapshot?.workspaceRoot, canonicalRoot);
	assert.equal(manager.get(checkpoint.id)?.id, checkpoint.id);
	await manager.attachToBranch(checkpoint.id, 'branch');
	assert.equal(manager.list('branch')[0]?.id, checkpoint.id);
	const persistedKeys = [...values.keys()];
	assert.equal(persistedKeys.length, 1);
	// Opening the same workspace with either spelling retains the existing history.
	const reopened = new CheckpointManager(conversations, state, host); t.after(() => reopened.dispose());
	for (workspaceRoot of [canonicalRoot, hostRoot]) {
		assert.equal(reopened.get(checkpoint.id)?.id, checkpoint.id);
		assert.equal(reopened.listAll().length, 1);
	}
	await fs.writeFile(join(root, 'file'), 'two');
	await reopened.restore(checkpoint.id, { conversationToo: false, conversationId: 'branch' });
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'one');
	assert.equal(reopened.listAll().length, 2);
	assert.deepEqual([...values.keys()], persistedKeys);
});
