/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, realpath, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { CheckpointManager } from 'son-of-anton-core/dist/checkpoint/CheckpointManager';
import { buildCliHost, SOTA_PATHS } from '../cliHost';

test('CLI cleanup discovers another workspace from live legacy state without rewriting it', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'sota-cli-checkpoint-cleanup-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const first = path.join(directory, 'first'), second = path.join(directory, 'second'), storage = path.join(directory, 'snapshots');
	await mkdir(first); await mkdir(second); await writeFile(path.join(first, 'file'), 'Retain until deletion');
	let state = '{}'; const read = fs.readFileSync;
	t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => args[0] === SOTA_PATHS.state ? state : read(...args));
	const host = buildCliHost({ cwd: second }); const warnings: string[] = [];
	const manager = (root: string) => new CheckpointManager({ load: () => undefined, update() {} }, host.globalState, {
		storageRoot: storage, getWorkspaceRoot: () => root, config: { get: <T>(_key: string, fallback?: T) => fallback as T },
		confirmRestore: async () => false, notifier: { info() {}, warn(message) { warnings.push(message); }, error() {} },
	});
	const original = manager(first); t.after(() => original.dispose());
	const checkpoint = await original.capture('legacy-conversation', 0, 'Legacy checkpoint'); assert.ok(checkpoint?.fileSnapshot, warnings.join('\n'));
	const identity = createHash('sha256').update(await realpath(first)).digest('hex');
	await rm(path.join(storage, 'index-v1', identity), { recursive: true });
	state = JSON.stringify({ [`sota.checkpoints.index.${identity}`]: [checkpoint] });
	const deleting = manager(second); t.after(() => deleting.dispose()); await deleting.deleteFor('legacy-conversation');
	await assert.rejects(access(path.join(storage, identity, checkpoint.fileSnapshot.id)), { code: 'ENOENT' });
	assert.deepEqual(original.listAll(), []);
	assert.equal(host.globalState.get<unknown[]>(`sota.checkpoints.index.${identity}`)?.length, 1, 'legacy state remains a read-only source');
});

test('invalid CLI state cannot report complete legacy checkpoint cleanup', t => {
	let state = '{ damaged'; const read = fs.readFileSync;
	t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof read>) => args[0] === SOTA_PATHS.state ? state : read(...args));
	const host = buildCliHost();
	assert.throws(() => host.globalState.keys?.(), SyntaxError);
	state = 'null'; assert.throws(() => host.globalState.keys?.(), /Invalid saved CLI state/);
	state = '{}'; assert.deepEqual(host.globalState.keys?.(), []);
});
