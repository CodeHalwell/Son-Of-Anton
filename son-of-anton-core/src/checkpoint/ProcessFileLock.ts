/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const abandonedLocks = new Set<string>();
const OWNER = /^\.(lock|pin)-(\d+)-[a-f0-9-]+$/;

/** An unknown/inaccessible process remains live; PID reuse never permits stealing its files. */
export function processOwnerAlive(name: string): boolean {
	const owner = OWNER.exec(name); if (!owner) { return false; }
	try { process.kill(Number(owner[2]), 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Read one regular metadata file through a bounded, non-following descriptor. */
export function readCheckpointMetadata(file: string, limit: number): string {
	const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size > limit) { throw new Error('Invalid or oversized checkpoint metadata.'); }
		const buffer = Buffer.allocUnsafe(stat.size); let offset = 0;
		while (offset < buffer.length) { const read = fs.readSync(descriptor, buffer, offset, buffer.length - offset, offset); if (!read) { throw new Error('Checkpoint metadata changed while reading.'); } offset += read; }
		if (fs.readSync(descriptor, Buffer.allocUnsafe(1), 0, 1, offset)) { throw new Error('Checkpoint metadata changed while reading.'); }
		return buffer.toString('utf8');
	} finally { fs.closeSync(descriptor); }
}

export async function atomicCheckpointWrite(destination: string, body: string, onCommitted?: () => void): Promise<void> {
	const temporary = path.join(path.dirname(destination), `.write-${randomUUID()}.tmp`);
	try {
		const handle = await fsp.open(temporary, 'wx', 0o600);
		try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
		for (let attempt = 0; ; attempt++) {
			try { await fsp.rename(temporary, destination); break; }
			catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt >= 20) { throw error; }
				// Another process can briefly hold the old metadata open on Windows. Keep it
				// published while retrying: unlinking a choosing ticket would break exclusion.
				await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, (attempt + 1) * 10)));
			}
		}
		onCommitted?.();
	} finally { await fsp.rm(temporary, { force: true }); }
}

/** Unique tickets publish a choosing phase before selecting an order, including across processes. */
export async function withCheckpointLock<T>(directory: string, operation: () => Promise<T>, report: (message: string) => void = () => {}): Promise<T> {
	await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
	for (const file of abandonedLocks) { try { await fsp.rm(file, { force: true }); abandonedLocks.delete(file); } catch { /* Retry when storage recovers. */ } }
	const warn = (error: unknown): void => { try { report(`Checkpoint lock cleanup will be retried: ${String(error)}`); } catch { /* Cleanup diagnostics cannot change operation results. */ } };
	const name = `.lock-${process.pid}-${randomUUID()}`; const owned = path.join(directory, name);
	const contenders = (): { name: string; ticket: number }[] => fs.readdirSync(directory).flatMap(entry => {
		if (entry === name || !entry.startsWith('.lock-') || !OWNER.test(entry)) { return []; }
		if (!processOwnerAlive(entry)) { fs.rmSync(path.join(directory, entry), { force: true }); return []; }
		try {
			const body = readCheckpointMetadata(path.join(directory, entry), 32);
			const ticket: unknown = JSON.parse(body);
			if (!Number.isSafeInteger(ticket) || (ticket as number) < 0) { throw new Error('Invalid checkpoint lock.'); }
			return [{ name: entry, ticket: ticket as number }];
		} catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error; }
	});
	try {
		// Publish the initial choosing phase synchronously. No contender may pass it.
		const preparing = `${owned}.tmp`;
		try { fs.writeFileSync(preparing, '0', { flag: 'wx', mode: 0o600 }); fs.renameSync(preparing, owned); }
		finally { fs.rmSync(preparing, { force: true }); }
		const ticket = Math.max(0, ...contenders().map(entry => entry.ticket)) + 1;
		if (!Number.isSafeInteger(ticket)) { throw new Error('Invalid checkpoint lock counter.'); }
		await atomicCheckpointWrite(owned, String(ticket)); const deadline = Date.now() + 10_000;
		while (contenders().some(entry => entry.ticket === 0 || entry.ticket < ticket || (entry.ticket === ticket && entry.name < name))) {
			if (Date.now() >= deadline) { throw new Error('Another checkpoint operation is in progress. Please retry after it finishes.'); }
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		}
		return await operation();
	} finally { try { await fsp.rm(owned, { force: true }); } catch (error) { abandonedLocks.add(owned); warn(error); } }
}
