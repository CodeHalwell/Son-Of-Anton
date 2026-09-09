/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { ConversationDeletedError, ConversationStorage } from '../src/chat/ConversationStorage';
import { attachConversationWriteToken } from '../src/chat/ConversationWriteToken';
import type { ConversationRecord } from '../src/chat/ConversationStore';

function record(content = 'retained transcript'): ConversationRecord {
	return { summary: { id: 'conversation', title: 'title', createdAt: 1, updatedAt: 2, messageCount: 1 }, messages: [{ role: 'user', content, timestamp: 1 }] };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function internal(storage: ConversationStorage) { return storage as unknown as { atomicWrite(file: string, body: string): Promise<void>; withLifecycleLock<T>(id: string, operation: () => Promise<T>): Promise<T>; reclaimDeleted(id: string): Promise<void> }; }
async function fixture(run: (storage: ConversationStorage, directory: string, folder: string, marker: string, issues: string[]) => Promise<void>): Promise<void> {
	const directory = await fsp.mkdtemp(path.join(tmpdir(), 'sota-delete-fence-')); const hash = createHash('sha256').update('conversation').digest('hex'); const issues: string[] = [];
	try { await run(new ConversationStorage(directory, issue => issues.push(issue.message)), directory, path.join(directory, hash), path.join(directory, '.lifecycle', hash, 'deletion.json'), issues); }
	finally { await fsp.rm(directory, { recursive: true, force: true }); }
}
function child(directory: string, scenario: { mode: 'reject' | 'stage'; record: ConversationRecord } | { mode: 'crash'; state: 'pending' | 'deleted' }) {
	const running = spawn(process.execPath, ['--require', 'tsx/cjs', path.resolve('test/fixtures/conversationStorageWriter.ts'), directory, JSON.stringify(scenario)], { stdio: ['pipe', 'pipe', 'pipe'] });
	let output = ''; let errors = ''; const staged = deferred();
	running.stdout.on('data', data => { output += String(data); if (output.includes('staged')) { staged.resolve(); } });
	running.stderr.on('data', data => { errors += String(data); });
	const done = new Promise<void>((resolve, reject) => { running.once('error', reject); running.once('exit', code => { if (code === 0) { resolve(); } else { reject(new Error(`Writer process failed (${code}): ${errors}`)); } }); });
	const staging = Promise.race([staged.promise, done.then(() => { throw new Error('Writer exited before staging'); })]);
	void staging.catch(() => {}); // Some child scenarios intentionally never stage a writer.
	return { running, staged: staging, done, output: () => output };
}

suite('Permanent conversation tombstones', () => {
	test('permanent IDs reject stale saves in another actual process and mask legacy-recreated manifests', async () => {
		await fixture(async (storage, directory, folder) => {
			const before = record(); await storage.save(before); const backup = await fsp.mkdtemp(path.join(tmpdir(), 'sota-delete-backup-'));
			try {
				await fsp.cp(folder, backup, { recursive: true }); await storage.delete('conversation');
				await assert.rejects(new ConversationStorage(directory).save(before), ConversationDeletedError);
				const writer = child(directory, { mode: 'reject', record: before });
				await writer.done; assert.equal(fs.existsSync(folder), false);
				await fsp.cp(backup, folder, { recursive: true });
				assert.deepEqual({ load: storage.load('conversation'), list: storage.list(), asyncList: await storage.listAsync(), match: await storage.matches('conversation', 'retained') }, { load: undefined, list: [], asyncList: [], match: false });
				await storage.cleanupDeleted(); assert.equal(fs.existsSync(folder), false);
				const next = record(); const fresh = { ...next, summary: { ...next.summary, id: 'fresh' } }; await storage.save(fresh); assert.ok(storage.load('fresh'));
			} finally { await fsp.rm(backup, { recursive: true, force: true }); }
		});
	});

	test('a staged writer in another process cannot commit across a pending delete barrier', async () => {
		await fixture(async (storage, directory, _folder, marker) => {
			await storage.save(record());
			const writer = child(directory, { mode: 'stage', record: record('stale body') });
			let deletion: Promise<void> | undefined;
			try {
				await writer.staged; const started = deferred(); const write = internal(storage).atomicWrite.bind(storage);
				internal(storage).atomicWrite = async (file, body) => { await write(file, body); if (file === marker && JSON.parse(body).state === 'pending') { started.resolve(); } };
				deletion = storage.delete('conversation'); await started.promise;
				assert.equal(storage.load('conversation'), undefined); writer.running.stdin.end('continue');
				await writer.done; await deletion; assert.ok(storage.isPermanentlyDeleted('conversation'));
			} finally { if (!writer.running.stdin.writableEnded) { writer.running.stdin.end('continue'); } await writer.done; await deletion; }
		});
	});

	test('a published choosing phase blocks another ticket until late publication is complete', async () => {
		await fixture(async (first, directory) => {
			const second = new ConversationStorage(directory); const choosing = deferred(); const releaseTicket = deferred(); const secondPublished = deferred();
			const writeFirst = internal(first).atomicWrite.bind(first); const writeSecond = internal(second).atomicWrite.bind(second);
			internal(first).atomicWrite = async (file, body) => { if (path.basename(file).startsWith('.writer-')) { choosing.resolve(); await releaseTicket.promise; } await writeFirst(file, body); };
			internal(second).atomicWrite = async (file, body) => { await writeSecond(file, body); if (path.basename(file).startsWith('.writer-')) { secondPublished.resolve(); } };
			let active = 0; let entered = 0; const operation = async () => { assert.equal(active++, 0); entered++; await new Promise<void>(resolve => setTimeout(resolve, 15)); assert.equal(--active, 0); };
			const a = internal(first).withLifecycleLock('conversation', operation); await choosing.promise;
			const b = internal(second).withLifecycleLock('conversation', operation); await secondPublished.promise;
			try { await new Promise<void>(resolve => setTimeout(resolve, 20)); assert.equal(entered, 0, 'positive ticket cannot pass an earlier choosing phase'); }
			finally { releaseTicket.resolve(); await Promise.all([a, b]); }
			assert.equal(entered, 2);
		});
	});

	test('simultaneous lockers safely reclaim a dead owner without removing a successor lease', async () => {
		await fixture(async (first, directory, _folder, marker) => {
			const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
			await fsp.mkdir(path.dirname(marker), { recursive: true }); const deadLease = path.join(path.dirname(marker), `.writer-${deadPid}-${randomUUID()}`); await fsp.writeFile(deadLease, '0');
			const second = new ConversationStorage(directory); let active = 0; let entered = 0;
			const operation = async () => { assert.equal(active++, 0); entered++; await new Promise<void>(resolve => setTimeout(resolve, 15)); assert.equal(--active, 0); };
			await Promise.all([internal(first).withLifecycleLock('conversation', operation), internal(second).withLifecycleLock('conversation', operation)]);
			assert.equal(entered, 2); assert.equal(fs.existsSync(deadLease), false); assert.deepEqual(await fsp.readdir(path.dirname(marker)), []);
		});
	});

	for (const failureState of ['pending', 'deleted']) {
		test(`failure writing ${failureState} marker restores the complete transcript and permits retry`, async () => {
			await fixture(async (storage, _directory, _folder, marker) => {
				await storage.save(record()); const write = internal(storage).atomicWrite.bind(storage);
				internal(storage).atomicWrite = async (file, body) => { if (file === marker && JSON.parse(body).state === failureState) { throw new Error('marker unavailable'); } await write(file, body); };
				await assert.rejects(storage.delete('conversation'), /marker unavailable/); assert.deepEqual(storage.load('conversation'), record()); assert.equal(fs.existsSync(marker), false);
				internal(storage).atomicWrite = write; await storage.delete('conversation'); assert.equal(storage.load('conversation'), undefined);
			});
		});
	}

	test('a committed marker remains final when lease completion reports an error', async () => {
		await fixture(async (storage, _directory, _folder, marker) => {
			await storage.save(record()); const write = internal(storage).atomicWrite.bind(storage);
			internal(storage).atomicWrite = async (file, body) => { await write(file, body); if (file === marker && JSON.parse(body).state === 'deleted') { throw new Error('post-commit failure'); } };
			await storage.delete('conversation'); assert.ok(storage.isPermanentlyDeleted('conversation')); assert.equal(storage.load('conversation'), undefined);
		});
	});

	test('reclamation failure never rolls back deletion and startup cleanup retries it', async () => {
		await fixture(async (storage, directory, folder, marker, issues) => {
			await storage.save(record()); const write = internal(storage).atomicWrite.bind(storage); const lease = path.join(folder, `.reader-${(process as NodeJS.Process).pid}-${randomUUID()}`);
			internal(storage).atomicWrite = async (file, body) => { await write(file, body); if (file === marker && JSON.parse(body).state === 'deleted') { await fsp.writeFile(lease, '[]'); } };
			await storage.delete('conversation'); assert.ok(fs.existsSync(folder)); assert.equal(storage.load('conversation'), undefined); assert.ok(issues.some(issue => /Cleanup will be retried/.test(issue)));
			await fsp.rm(lease); await new ConversationStorage(directory).cleanupDeleted(); assert.equal(fs.existsSync(folder), false); assert.ok(fs.existsSync(marker));
		});
	});

	for (const crashState of ['pending', 'deleted'] as const) {
		test(`process crash after ${crashState} marker recovers the correct durable state`, async () => {
			await fixture(async (storage, directory, folder, marker) => {
				await storage.save(record());
				const writer = child(directory, { mode: 'crash', state: crashState });
				await writer.done; assert.equal(storage.isPermanentlyDeleted('conversation'), crashState === 'deleted');
				await storage.cleanupDeleted();
				assert.equal(fs.existsSync(marker), crashState === 'deleted'); assert.equal(fs.existsSync(folder), crashState === 'pending');
				if (crashState === 'pending') { assert.deepEqual(storage.load('conversation'), record()); await storage.save(attachConversationWriteToken(record('new content'), storage.load('conversation')!.writeToken!)); }
			});
		});
	}
});
