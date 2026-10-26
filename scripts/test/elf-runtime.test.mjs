/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { needsNativeLibraries } from '../elf-runtime.mjs';

function elf(machine, needed) {
	const bytes = Buffer.alloc(152);
	bytes.set([127, 69, 76, 70, 2, 1]); bytes.writeUInt16LE(machine, 18);
	bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
	bytes.writeUInt32LE(2, 64); bytes.writeBigUInt64LE(120n, 72); bytes.writeBigUInt64LE(32n, 96);
	bytes.writeBigInt64LE(needed ? 1n : 0n, 120);
	return bytes;
}
test('a real native Node executable is recognized on Linux x64', async () => {
	assert.equal(needsNativeLibraries(await readFile(process.execPath)), process.platform === 'linux' && process.arch === 'x64');
});
test('foreign architecture and static helpers do not enter native dependency derivation', () => {
	assert.equal(needsNativeLibraries(elf(62, true)), true);
	assert.equal(needsNativeLibraries(elf(183, true)), false);
	assert.equal(needsNativeLibraries(elf(62, false)), false);
});
test('truncated or invalid ELF program headers fail closed', () => {
	const bytes = elf(62, true);
	assert.equal(needsNativeLibraries(bytes.subarray(0, 100)), false);
	bytes.writeBigUInt64LE(999999n, 72);
	assert.equal(needsNativeLibraries(bytes), false);
});
