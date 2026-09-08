/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { installVerifiedBinary } from '../commands/update';
for (const scenario of ['success', 'checksum', 'swap-failure', 'locked-install'] as const) {
	test(`binary upgrade: ${scenario}`, t => {
		const folder = fs.mkdtempSync(join(tmpdir(), 'sota-upgrade-')); t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
		const installed = join(folder, 'installed'), download = join(folder, 'download'); fs.writeFileSync(installed, 'old'); fs.writeFileSync(download, 'new');
		const checksum = createHash('sha256').update(scenario === 'checksum' ? 'invalid' : 'new').digest('hex');
		let renames = 0;
		const rename: typeof fs.renameSync = (from, to) => { renames++; if ((scenario === 'swap-failure' && renames === 2) || scenario === 'locked-install') { throw new Error('EPERM fixture'); } fs.renameSync(from, to); };
		if (scenario === 'success') { const backup = installVerifiedBinary(installed, download, checksum, rename); assert.deepEqual([fs.readFileSync(installed, 'utf8'), fs.readFileSync(backup, 'utf8')], ['new', 'old']); }
		else { assert.throws(() => installVerifiedBinary(installed, download, checksum, rename), /SHA256|EPERM/); assert.equal(fs.readFileSync(installed, 'utf8'), 'old'); }
		assert.equal(fs.readdirSync(folder).some(file => file.endsWith('.new')), false);
	});
}
