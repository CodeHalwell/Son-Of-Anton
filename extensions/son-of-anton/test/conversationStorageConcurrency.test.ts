/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { ConversationConflictError, ConversationStorage } from '../src/chat/ConversationStorage';
import { ConversationStore, type ConversationRecord } from '../src/chat/ConversationStore';

function record(content = 'original', count = 1): ConversationRecord {
	return { summary: { id: 'conversation', title: 'title', createdAt: 1, updatedAt: 2, messageCount: count }, messages: Array.from({ length: count }, (_, timestamp) => ({ role: 'user', content, timestamp })) };
}
function append(next: ConversationRecord, content: string): ConversationRecord { next.messages.push({ role: 'assistant', content, timestamp: 3 }); return next; }
function pageNames(folder: string): string[] { return fs.readdirSync(folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort(); }
async function fixture(run: (storage: ConversationStorage, directory: string, folder: string, issues: string[]) => Promise<void>): Promise<void> {
	const directory = await fsp.mkdtemp(path.join(tmpdir(), 'sota-conversation-cas-')); const issues: string[] = [];
	try { await run(new ConversationStorage(directory, issue => issues.push(issue.message)), directory, path.join(directory, createHash('sha256').update('conversation').digest('hex')), issues); }
	finally { await fsp.rm(directory, { recursive: true, force: true }); }
}
function internal(storage: ConversationStorage) { return storage as unknown as { atomicWrite(file: string, body: string): Promise<void>; waitForCollectors(folder: string): Promise<void> }; }
class Memento implements vscode.Memento {
	private readonly values = new Map<string, unknown>();
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	keys(): string[] { return [...this.values.keys()]; }
	async update(key: string, value: unknown): Promise<void> { if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); } }
}

suite('Conversation revision compare-and-swap', () => {
	test('a separate process loaded before an append cannot erase the newer turn or its pages', async () => {
		await fixture(async (storage, directory, folder) => {
			await storage.save(record('original', 100));
			const child = spawn(process.execPath, ['--require', 'tsx/cjs', path.resolve('test/fixtures/conversationStorageWriter.ts'), directory, JSON.stringify({ mode: 'stale', id: 'conversation', content: 'stale child output' })], { stdio: ['pipe', 'pipe', 'pipe'] });
			let errors = ''; let output = ''; let ready!: () => void; const loaded = new Promise<void>(resolve => { ready = resolve; });
			child.stdout.on('data', data => { output += String(data); if (output.includes('loaded')) { ready(); } }); child.stderr.on('data', data => { errors += String(data); });
			const done = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { if (code === 0) { resolve(); } else { reject(new Error(`Writer failed (${code}): ${errors}`)); } }); });
			try {
				await Promise.race([loaded, done.then(() => { throw new Error('Writer exited before loading'); })]);
				await storage.save(append(storage.load('conversation')!, 'newer durable turn'));
				const winningPages = pageNames(folder); child.stdin.end('continue'); await done;
				assert.equal(new ConversationStorage(directory).load('conversation')?.messages.at(-1)?.content, 'newer durable turn'); assert.deepEqual(pageNames(folder), winningPages);
				await storage.save(append(storage.load('conversation')!, 'after collection'));
				assert.deepEqual(new ConversationStorage(directory).load('conversation')?.messages.slice(-2).map(message => message.content), ['newer durable turn', 'after collection']);
			} finally { if (!child.stdin.writableEnded) { child.stdin.end('continue'); } await done; }
		});
	});

	test('simultaneous writers of one revision have exactly one winner', async () => {
		await fixture(async (first, directory, folder) => {
			await first.save(record()); const second = new ConversationStorage(directory);
			const left = append(first.load('conversation')!, 'left'); const right = append(second.load('conversation')!, 'right');
			const results = await Promise.allSettled([first.save(left), second.save(right)]);
			assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
			const rejected = results.find(result => result.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ConversationConflictError);
			assert.equal(new ConversationStorage(directory).load('conversation')?.messages.at(-1)?.content, results[0].status === 'fulfilled' ? 'left' : 'right'); assert.equal(pageNames(folder).length, 1);
		});
	});

	test('metadata changes conflict while full loads of the legacy manifest schema remain writable', async () => {
		await fixture(async (storage, directory, folder) => {
			await storage.save(record()); const stale = storage.load('conversation')!;
			const manifest = JSON.parse(await fsp.readFile(path.join(folder, 'manifest.json'), 'utf8'));
			assert.equal(manifest.version, 1); assert.equal(manifest.contentHash, undefined); assert.equal(manifest.writeToken, undefined);
			manifest.summary.title = 'renamed by legacy writer'; await fsp.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
			await assert.rejects(storage.save(append(stale, 'stale')), ConversationConflictError);
			const current = new ConversationStorage(directory).load('conversation')!; await storage.save(append(current, 'fresh'));
			assert.equal(storage.load('conversation')?.summary.title, 'renamed by legacy writer'); assert.equal(storage.load('conversation')?.messages.at(-1)?.content, 'fresh');
		});
	});

	test('unversioned replacements and partial transcript reads cannot overwrite existing history', async () => {
		await fixture(async storage => {
			await storage.save(record('original', 101)); await assert.rejects(storage.save(record('unversioned')), ConversationConflictError);
			const partial = storage.load('conversation', 0, 1)!; assert.equal(partial.writeToken, undefined);
			await assert.rejects(storage.save(partial), ConversationConflictError); assert.equal(storage.load('conversation')?.messages.length, 101);
		});
	});

	test('failure before commit retains the old lineage and permits retry', async () => {
		await fixture(async storage => {
			await storage.save(record()); const next = append(storage.load('conversation')!, 'retry me'); const revision = next.writeToken!.revision; const write = internal(storage).atomicWrite.bind(storage);
			internal(storage).atomicWrite = async (file, body) => { if (file.endsWith('manifest.json')) { throw new Error('no space'); } await write(file, body); };
			await assert.rejects(storage.save(next), /no space/); assert.equal(next.writeToken!.revision, revision); assert.equal(storage.load('conversation')?.messages.length, 1);
			internal(storage).atomicWrite = write; await storage.save(next); assert.notEqual(next.writeToken!.revision, revision); assert.equal(storage.load('conversation')?.messages.length, 2);
		});
	});

	test('an error after manifest rename still commits and advances its lineage', async () => {
		await fixture(async storage => {
			await storage.save(record()); const next = append(storage.load('conversation')!, 'committed'); const revision = next.writeToken!.revision; const write = internal(storage).atomicWrite.bind(storage);
			internal(storage).atomicWrite = async (file, body) => { await write(file, body); if (file.endsWith('manifest.json')) { throw new Error('temporary cleanup failure'); } };
			await storage.save(next); assert.notEqual(next.writeToken!.revision, revision); assert.equal(storage.load('conversation')?.messages.at(-1)?.content, 'committed');
		});
	});

	test('postcommit cleanup failure reports recovery while pending fork saves advance', async () => {
		await fixture(async (_storage, directory) => {
			const context = { globalState: new Memento(), workspaceState: new Memento(), globalStorageUri: vscode.Uri.file(directory) } as unknown as vscode.ExtensionContext;
			const store = new ConversationStore(context); await store.ready;
			const disk = (store as unknown as { disk: ConversationStorage }).disk; const wait = internal(disk).waitForCollectors.bind(disk); let calls = 0;
			internal(disk).waitForCollectors = async folder => { if (++calls === 2) { throw new Error('collector still busy after commit'); } await wait(folder); };
			try {
				const created = store.create(record().messages); const fork = store.load(created.summary.id)!;
				assert.notEqual(fork.writeToken, created.writeToken); store.update(fork.summary.id, append(fork, 'queued child').messages, undefined, undefined, undefined, undefined, fork.writeToken);
				await store.flush(); assert.equal(disk.load(created.summary.id)?.messages.at(-1)?.content, 'queued child'); assert.ok(store.recoveryIssues.some(issue => issue.message.includes('collector still busy')));
			} finally { store.dispose(); await store.flush(); }
		});
	});

	test('a fork of a failed queued snapshot retains its settled base for a safe retry', async () => {
		await fixture(async (_storage, directory) => {
			const context = { globalState: new Memento(), workspaceState: new Memento(), globalStorageUri: vscode.Uri.file(directory) } as unknown as vscode.ExtensionContext;
			const store = new ConversationStore(context); await store.ready;
			const disk = (store as unknown as { disk: ConversationStorage }).disk; const save = disk.save.bind(disk); let calls = 0;
			disk.save = async next => { if (++calls === 2) { throw new Error('temporary unavailable disk'); } await save(next); };
			try {
				const created = store.create(record().messages);
				store.update(created.summary.id, append(created, 'unsaved predecessor').messages, undefined, undefined, undefined, undefined, created.writeToken);
				const fork = store.load(created.summary.id)!;
				store.update(fork.summary.id, append(fork, 'retry from fork').messages, undefined, undefined, undefined, undefined, fork.writeToken);
				await store.flush(); assert.deepEqual(disk.load(created.summary.id)?.messages.map(message => message.content), ['original', 'unsaved predecessor', 'retry from fork']);
			} finally { store.dispose(); await store.flush(); }
		});
	});

	test('throwing recovery listeners cannot reject committed writes or mask stale conflicts', async () => {
		await fixture(async (_storage, directory) => {
			const storage = new ConversationStorage(directory, () => { throw new Error('listener unavailable'); });
			const wait = internal(storage).waitForCollectors.bind(storage); let calls = 0;
			internal(storage).waitForCollectors = async folder => { if (++calls === 2) { throw new Error('cleanup unavailable'); } await wait(folder); };
			const next = record(); await storage.save(next); assert.ok(next.writeToken?.revision);
			const stale = storage.load('conversation')!; await storage.save(append(next, 'committed'));
			await assert.rejects(storage.save(append(stale, 'stale')), ConversationConflictError);
			assert.equal(storage.load('conversation')?.messages.at(-1)?.content, 'committed');
		});
	});

	test('write tokens stay out of history exports and cloned payloads', async () => {
		await fixture(async storage => {
			const next = record(); await storage.save(next); const loaded = storage.load('conversation')!;
			assert.ok(loaded.writeToken); assert.equal(JSON.stringify(loaded).includes('writeToken'), false); assert.equal(structuredClone(loaded).writeToken, undefined);
		});
	});
});
