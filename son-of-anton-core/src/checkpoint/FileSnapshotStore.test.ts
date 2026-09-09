/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSnapshotStore, type FileSnapshot } from './FileSnapshotStore';

async function fixture(t: TestContext) {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-file-checkpoint-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const root = join(directory, 'workspace'); await fs.mkdir(root);
	return { root, directory, store: new FileSnapshotStore(root, join(directory, 'storage')) };
}

test('non-Git restore previews changes, removes later files and retains a reversible recovery', async t => {
	const { root, store } = await fixture(t); await fs.writeFile(join(root, 'hello.txt'), 'before');
	await fs.mkdir(join(root, 'node_modules')); await fs.writeFile(join(root, 'node_modules', 'dependency'), 'excluded');
	const snapshot = await store.capture(); await fs.writeFile(join(root, 'hello.txt'), 'after'); await fs.writeFile(join(root, 'later.txt'), 'new file');
	let preview: readonly string[] = [];
	const recovery = await store.restore(snapshot, async files => { preview = files; return true; });
	assert.deepEqual({ preview, hello: await fs.readFile(join(root, 'hello.txt'), 'utf8'), files: await fs.readdir(root), dependency: await fs.readFile(join(root, 'node_modules', 'dependency'), 'utf8') }, { preview: ['hello.txt', 'later.txt'], hello: 'before', files: ['hello.txt', 'node_modules'], dependency: 'excluded' });
	assert.ok(recovery); await store.restore(recovery, async () => true);
	assert.equal(await fs.readFile(join(root, 'later.txt'), 'utf8'), 'new file');
});

test('cancellation and edits made during confirmation leave current files untouched', async t => {
	const { root, store } = await fixture(t); await fs.writeFile(join(root, 'code.txt'), 'one'); const snapshot = await store.capture(); await fs.writeFile(join(root, 'code.txt'), 'two');
	assert.equal(await store.restore(snapshot, async () => false), undefined);
	await assert.rejects(store.restore(snapshot, async () => { await fs.writeFile(join(root, 'code.txt'), 'three'); return true; }), /changed while confirming/);
	assert.equal(await fs.readFile(join(root, 'code.txt'), 'utf8'), 'three');
});

test('snapshot refuses symlinks and cross-workspace restore', async t => {
	const { root, directory, store } = await fixture(t); await fs.writeFile(join(root, 'file'), 'original'); const snapshot = await store.capture();
	const other = join(directory, 'other'); await fs.mkdir(other);
	await assert.rejects(new FileSnapshotStore(other, join(directory, 'storage')).restore(snapshot, async () => true), /different workspace/);
	await fs.symlink(join(directory, 'storage'), join(root, 'link'));
	await assert.rejects(store.capture(), /symbolic links/);
});

test('file-directory transitions restore without deleting excluded dependency contents', async t => {
	const { root, store } = await fixture(t); await fs.writeFile(join(root, 'item'), 'file'); const fileSnapshot = await store.capture();
	await fs.unlink(join(root, 'item')); await fs.mkdir(join(root, 'item')); await fs.writeFile(join(root, 'item', 'child'), 'child'); const directorySnapshot = await store.capture();
	await store.restore(fileSnapshot, async () => true); assert.equal(await fs.readFile(join(root, 'item'), 'utf8'), 'file');
	await store.restore(directorySnapshot, async () => true); assert.equal(await fs.readFile(join(root, 'item', 'child'), 'utf8'), 'child');
	await fs.mkdir(join(root, 'item', 'node_modules')); await fs.writeFile(join(root, 'item', 'node_modules', 'precious'), 'keep');
	await assert.rejects(store.restore(fileSnapshot, async () => true), /recovered/);
	assert.equal(await fs.readFile(join(root, 'item', 'node_modules', 'precious'), 'utf8'), 'keep');
});

test('capture rejects a substituted file descriptor before reading its content', async t => {
	const { root, directory, store } = await fixture(t);
	const target = join(root, 'file'); const external = join(directory, 'outside');
	await fs.writeFile(target, 'original'); await fs.writeFile(external, 'external');
	const canonicalTarget = await fs.realpath(target); const open = fs.open; let reads = 0;
	t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
		if (String(args[0]) !== canonicalTarget) { return open(...args); }
		// Model an ancestor-path substitution that is undone before path rechecks.
		const handle = await open(external, args[1], args[2]);
		t.mock.method(handle, 'read', () => { reads++; throw new Error('External file content must not be read'); });
		return handle;
	});
	await assert.rejects(store.capture(), /File changed while capturing/);
	assert.equal(reads, 0);
});

test('capture rejects a file that grows after the descriptor has been inspected', async t => {
	const { root, store } = await fixture(t); const target = join(root, 'file'); await fs.writeFile(target, 'original');
	const canonicalTarget = await fs.realpath(target); const open = fs.open; let changed = false;
	t.mock.method(fs, 'open', async (...args: Parameters<typeof open>) => {
		const handle = await open(...args); if (String(args[0]) !== canonicalTarget) { return handle; }
		const read = handle.read;
		t.mock.method(handle, 'read', async (...parameters: Parameters<typeof read>) => {
			if (!changed) { changed = true; await fs.appendFile(target, ' grew during capture'); }
			return Reflect.apply(read, handle, parameters) as ReturnType<typeof read>;
		});
		return handle;
	});
	await assert.rejects(store.capture(), /File changed while capturing/);
	assert.equal(changed, true);
});


test('a host commit marker preserves recovery when its retention callback subsequently fails', async t => {
	const { root, store } = await fixture(t); await fs.writeFile(join(root, 'file'), 'target'); const target = await store.capture(); await fs.writeFile(join(root, 'file'), 'pre-restore');
	let retained: FileSnapshot | undefined;
	await assert.rejects(store.restore(target, async () => true, async (snapshot, markRetained) => { retained = snapshot; markRetained(); throw new Error('workspace changed after persistence'); }), /workspace changed after persistence/);
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'pre-restore'); assert.ok(retained);
	await fs.writeFile(join(root, 'file'), 'subsequent edit'); await store.restore(retained, async () => true);
	assert.equal(await fs.readFile(join(root, 'file'), 'utf8'), 'pre-restore');
});
