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
import { execFileSync } from 'node:child_process';
import { ConversationStorage } from '../src/chat/ConversationStorage';
import type { ConversationRecord } from '../src/chat/ConversationStore';

function record(text: string, count = 1): ConversationRecord {
	return { summary: { id: 'conversation', title: text, createdAt: 1, updatedAt: 2, messageCount: count }, messages: Array.from({ length: count }, (_, index) => ({ role: 'user', content: `${text}-${index}`, timestamp: index })) };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function pages(folder: string): string[] { return fs.readdirSync(folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
function saveInOtherProcess(directory: string, next: ConversationRecord): void {
	const script = 'const { ConversationStorage } = require(process.argv[1]); new ConversationStorage(process.argv[2]).save(JSON.parse(process.argv[3])).catch(error => { console.error(error); process.exitCode = 1; });';
	execFileSync(process.execPath, ['--require', 'tsx/cjs', '-e', script, path.resolve('src/chat/ConversationStorage.ts'), directory, JSON.stringify(next)], { timeout: 5000 });
}
async function withStorage(run: (storage: ConversationStorage, directory: string, folder: string) => Promise<void>): Promise<void> {
	const directory = await fsp.mkdtemp(path.join(tmpdir(), 'sota-page-gc-'));
	const folder = path.join(directory, createHash('sha256').update('conversation').digest('hex'));
	try { await run(new ConversationStorage(directory), directory, folder); }
	finally { await fsp.rm(directory, { recursive: true, force: true }); }
}

suite('Conversation immutable page collection', () => {
	test('reclaims obsolete hashes after a committed append while retaining the full transcript', async () => {
		await withStorage(async (storage, _directory, folder) => {
			for (const count of [1, 2, 99, 100, 101, 102, 201]) {
				const next = record('message', count); await storage.save(next);
				assert.deepEqual({ pageCount: pages(folder).length, loaded: storage.load(next.summary.id) }, { pageCount: Math.ceil(count / 100), loaded: next });
			}
			assert.equal(fs.readdirSync(folder).filter(name => /^\.(reader|writer|gc)-/.test(name)).length, 0);
		});
	});

	test('preserves hashes reused by an overlapping writer before its manifest commits', async () => {
		await withStorage(async (storage, directory, folder) => {
			const original = record('original'); await storage.save(original); const originalPages = pages(folder);
			const otherWindow = new ConversationStorage(directory);
			const internal = otherWindow as unknown as { withLifecycleLock<T>(id: string, operation: () => Promise<T>): Promise<T> };
			const lock = internal.withLifecycleLock; const paused = deferred(); const release = deferred(); let calls = 0;
			internal.withLifecycleLock = async (id, operation) => { if (++calls === 2) { paused.resolve(); await release.promise; } return lock.call(otherWindow, id, operation) as ReturnType<typeof operation>; };
			const pending = otherWindow.save(original); await paused.promise;
			try {
				await storage.save(record('replacement'));
				assert.ok(originalPages.every(page => fs.existsSync(path.join(folder, page)) && fs.existsSync(path.join(folder, `${page}.search`))), 'A future committed manifest still needs the staged writer hashes');
			} finally { release.resolve(); await pending; }
			assert.deepEqual({ loaded: storage.load('conversation'), pages: pages(folder) }, { loaded: original, pages: originalPages });
		});
	});

	test('a new writer waits for an existing collector before reusing or creating pages', async () => {
		await withStorage(async (storage, _directory, folder) => {
			await storage.save(record('original')); const originalPages = pages(folder);
			const marker = path.join(folder, `.gc-${(process as NodeJS.Process).pid}-${randomUUID()}`); fs.writeFileSync(marker, '');
			const pending = storage.save(record('next')); await new Promise<void>(resolve => setTimeout(resolve, 30));
			try { assert.deepEqual(pages(folder), originalPages); }
			finally { fs.rmSync(marker, { force: true }); await pending; }
			assert.equal(storage.load('conversation')?.messages[0].content, 'next-0');
		});
	});

	test('a reader retains its snapshot while another process commits and collects pages', async () => {
		await withStorage(async (storage, directory, folder) => {
			const original = record('reader snapshot'); await storage.save(original);
			const internal = storage as unknown as { readPages(id: string, manifest: object, offset: number, limit: number): ConversationRecord };
			const read = internal.readPages; let retainedDuringRead = 0;
			internal.readPages = (id, manifest, offset, limit) => {
				saveInOtherProcess(directory, record('other process'));
				retainedDuringRead = pages(folder).length;
				return read.call(storage, id, manifest, offset, limit);
			};
			try { assert.deepEqual({ loaded: storage.load('conversation'), retainedDuringRead }, { loaded: original, retainedDuringRead: 2 }); }
			finally { internal.readPages = read; }
			await storage.save(record('final'));
			assert.deepEqual({ content: storage.load('conversation')?.messages[0].content, remaining: pages(folder).length }, { content: 'final-0', remaining: 1 });
		});
	});

	for (const code of ['EROFS', 'ENOSPC', 'EDQUOT']) {
		test(`${code} loading retries a collected snapshot without returning partial history`, async () => {
			await withStorage(async (storage, directory) => {
				await storage.save(record('old snapshot', 101));
				const internal = storage as unknown as {
					createLease(folder: string, kind: string, pages: readonly string[]): string;
					readPages(id: string, manifest: object, offset: number, limit: number, reportIssues?: boolean): ConversationRecord;
				};
				internal.createLease = () => { throw Object.assign(new Error('Storage cannot create a lease'), { code }); };
				const read = internal.readPages; let changed = false;
				internal.readPages = (id, manifest, offset, limit, reportIssues) => {
					if (!changed) {
						changed = true;
						saveInOtherProcess(directory, record('current snapshot'));
					}
					return read.call(storage, id, manifest, offset, limit, reportIssues);
				};
				assert.deepEqual(storage.load('conversation'), record('current snapshot'));
			});
		});
	}

	test('a collector marker from an exited process cannot block future saves', async () => {
		await withStorage(async (storage, _directory, folder) => {
			await storage.save(record('original'));
			const exitedPid = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
			const marker = path.join(folder, `.gc-${exitedPid}-${randomUUID()}`); fs.writeFileSync(marker, '');
			await storage.save(record('after restart'));
			assert.deepEqual({ content: storage.load('conversation')?.messages[0].content, staleMarker: fs.existsSync(marker) }, { content: 'after restart-0', staleMarker: false });
		});
	});
});
