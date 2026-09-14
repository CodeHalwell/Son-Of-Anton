/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBoundedFile } from './readBoundedFile';

test('bounded reads retain the opened file when its pathname is replaced', async t => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-bounded-read-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'source'); await fs.writeFile(file, 'original');
	const open = fs.open;
	t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		await fs.rename(file, join(directory, 'retained')); await fs.writeFile(file, 'replacement');
		return handle;
	});
	assert.equal((await readBoundedFile(file, 64)).content, 'original');
});

test('bounded reads reject non-files and oversized contents', async t => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-bounded-size-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'source'); await fs.writeFile(file, '12345');
	assert.equal((await readBoundedFile(file, 5)).content, '12345');
	await assert.rejects(readBoundedFile(file, 4), /size limit/);
	await assert.rejects(readBoundedFile(directory, 5));
});

test('a file growing after its size check still cannot exceed the read limit', async t => {
	const directory = await fs.mkdtemp(join(tmpdir(), 'sota-bounded-growth-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'source'); await fs.writeFile(file, 'small');
	const open = fs.open;
	t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args), info = await handle.stat();
		t.mock.method(handle, 'stat', async () => { await fs.appendFile(file, ' appended after the check'); return info; });
		return handle;
	});
	await assert.rejects(readBoundedFile(file, 8), /size limit/);
});
