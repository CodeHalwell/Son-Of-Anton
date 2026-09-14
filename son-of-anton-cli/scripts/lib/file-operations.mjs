/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** Windows can briefly retain an executable image lock after its process closes. */
export async function renameAfterExit(source, destination, options = {}) {
	const platform = options.platform ?? process.platform;
	const move = options.rename ?? rename;
	const wait = options.delay ?? delay;
	for (let attempt = 0; ; attempt++) {
		try { await move(source, destination); return; }
		catch (error) {
			if (platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES'].includes(error.code) || attempt >= 11) { throw error; }
			await wait(Math.min(100 * 2 ** attempt, 1000));
		}
	}
}
