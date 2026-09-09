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
import { createRequire } from 'node:module';
import * as vscode from 'vscode';
import { ConversationStore, type ConversationRecord } from '../src/chat/ConversationStore';
import { ConversationStorage } from '../src/chat/ConversationStorage';
import { ConversationActions } from '../src/chat/ConversationActions';
import { buildLegacySearchIndex, conversationTextChunks, searchIndexMatches } from '../src/chat/ConversationSearchIndex';
import type { ChatMessage } from '../src/chat/ChatPanel';

const nativeFs = createRequire(import.meta.url)('node:fs') as typeof fs;
function memento(): vscode.Memento {
	const values = new Map<string, object>();
	return { get: <T>(key: string, fallback?: T): T => (values.get(key) ?? fallback) as T, update: async (key: string, value: object) => { if (value === undefined) { values.delete(key); } else { values.set(key, value); } }, keys: () => [...values.keys()] };
}
function record(id: string, messages: ChatMessage[]): ConversationRecord { return { summary: { id, title: id, createdAt: 1, updatedAt: 1, messageCount: messages.length, workspaceId: 'workspace' }, messages }; }
function text(content: string): ChatMessage { return { role: 'assistant', content, timestamp: 1 }; }
function imageRecord(id = 'conversation'): ConversationRecord {
	return record(id, [{ role: 'user', content: [{ type: 'text', text: 'Find the hidden needle across history' }, { type: 'image', mimeType: 'image/png', base64Data: 'SECRET_IMAGE_BYTES'.repeat(100_000) }], timestamp: 1 }]);
}
async function fixture(run: (store: ConversationStore, storage: ConversationStorage, directory: string, context: vscode.ExtensionContext) => Promise<void>): Promise<void> {
	const directory = await fsp.mkdtemp(path.join(tmpdir(), 'sota-history-search-'));
	const context = { globalState: memento(), workspaceState: memento(), globalStorageUri: vscode.Uri.file(directory) } as vscode.ExtensionContext;
	const store = new ConversationStore(context, 'workspace', 'Workspace'); await store.ready;
	try { await run(store, new ConversationStorage(path.join(directory, 'conversations-v2')), directory, context); }
	finally { store.dispose(); await store.flush(); await fsp.rm(directory, { recursive: true, force: true }); }
}
async function messagePage(directory: string, id = 'conversation'): Promise<string> {
	const folder = path.join(directory, 'conversations-v2', createHash('sha256').update(id).digest('hex'));
	const manifest = JSON.parse(await fsp.readFile(path.join(folder, 'manifest.json'), 'utf8')) as { pages: string[] };
	return path.join(folder, manifest.pages[0]);
}

suite('Bounded conversation text search', () => {
	test('reopened body queries read text indexes without synchronous transcript loads or image bytes', async () => {
		await fixture(async (store, storage, directory) => {
			await storage.save(imageRecord()); const page = await messagePage(directory);
			const index = await fsp.readFile(`${page}.search`, 'utf8');
			const originalRead = nativeFs.readFileSync;
			Object.assign(nativeFs, { readFileSync: (file: fs.PathOrFileDescriptor, ...args: object[]) => { if (String(file) === page) { throw new Error('Synchronous transcript reads are forbidden during search'); } return Reflect.apply(originalRead, nativeFs, [file, ...args]); } });
			Object.assign(store, { load: () => { throw new Error('Full transcript loads are forbidden during search'); } });
			try {
				assert.deepEqual({ body: (await store.searchAsync({ query: 'hidden needle' })).items.map(item => item.id), binary: (await store.searchAsync({ query: 'SECRET_IMAGE_BYTES' })).total, small: index.length < 2000, imageLeaked: index.includes('SECRET_IMAGE_BYTES') }, { body: ['conversation'], binary: 0, small: true, imageLeaked: false });
			} finally { Object.assign(nativeFs, { readFileSync: originalRead }); }
		});
	});

	test('body search keeps exact totals, paging, scope and cross-window updates', async () => {
		await fixture(async (store, storage) => {
			for (let index = 0; index < 6; index++) { const next = record(`conversation-${index}`, [text('Shared body needle')]); await storage.save({ ...next, summary: { ...next.summary, updatedAt: index, archived: index === 5, pinned: index === 0 } }); }
			const first = await store.searchAsync({ query: 'body needle', limit: 2 }); const second = await store.searchAsync({ query: 'body needle', offset: first.nextOffset, limit: 2 });
			assert.deepEqual({ first: first.items.map(item => item.id), second: second.items.map(item => item.id), total: first.total, next: second.nextOffset, archived: (await store.searchAsync({ query: 'body needle', scope: 'archived' })).items.map(item => item.id) }, { first: ['conversation-0', 'conversation-4'], second: ['conversation-3', 'conversation-2'], total: 5, next: 4, archived: ['conversation-5'] });
		});
	});

	test('1000-character Unicode queries find matches across normalized text chunk boundaries', async () => {
		await fixture(async (store, storage) => {
			const query = 'İ'.repeat(1000); const source = 'x'.repeat(16_000) + query + 'y'.repeat(17_000);
			await storage.save(record('unicode', [text(source)]));
			assert.equal((await store.searchAsync({ query })).total, 1);
			await assert.rejects(store.searchAsync({ query: 'a'.repeat(1001) }), /1000/);
		});
	});

	test('structured parts match across text boundaries but never across separate messages', async () => {
		const chunks = [...conversationTextChunks([{ role: 'user', content: [{ type: 'text', text: 'alpha' }, { type: 'image', mimeType: 'image/png', base64Data: 'hidden' }, { type: 'text', text: 'beta' }], timestamp: 1 }, text('gamma')])];
		assert.deepEqual({ joined: chunks.some(chunk => chunk.includes('alpha beta')), crossed: chunks.some(chunk => chunk.includes('beta gamma')), image: chunks.some(chunk => chunk.includes('hidden')) }, { joined: true, crossed: false, image: false });
	});

	test('legacy image pages backfill in a worker and leave no staging files or leases', async () => {
		await fixture(async (store, storage, directory) => {
			await storage.save(imageRecord()); const page = await messagePage(directory); await fsp.rm(`${page}.search`);
			let yielded = false; setImmediate(() => { yielded = true; });
			const result = await store.searchAsync({ query: 'hidden needle' });
			assert.deepEqual({ total: result.total, yielded, indexed: await searchIndexMatches(`${page}.search`, 'hidden needle'), leftovers: (await fsp.readdir(path.dirname(page))).filter(file => file.startsWith('.') || file.endsWith('.tmp')) }, { total: 1, yielded: true, indexed: true, leftovers: [] });
		});
	});

	test('cancelling legacy worker backfill terminates it and cleans staged output', async () => {
		await fixture(async (_store, storage, directory) => {
			await storage.save(imageRecord()); const page = await messagePage(directory); await fsp.rm(`${page}.search`);
			const controller = new AbortController(); const pending = buildLegacySearchIndex(page, `${page}.search`, 'needle', controller.signal);
			setImmediate(() => controller.abort(new Error('Superseded query')));
			await assert.rejects(pending, /Superseded query/);
			assert.deepEqual((await fsp.readdir(path.dirname(page))).filter(file => file.endsWith('.tmp') || file.endsWith('.search')), []);
		});
	});

	test('a disposed store aborts active search and rejects future requests', async () => {
		await fixture(async (store, storage) => {
			await storage.save(record('long', [text('body '.repeat(100_000))]));
			const search = store.searchAsync({ query: 'absent' }); store.dispose();
			await assert.rejects(search, /abort/i); await assert.rejects(store.searchAsync(), /abort/i);
		});
	});

	test('failed derived cache commits do not prevent authoritative history saves or legacy body matches', async () => {
		await fixture(async (store, storage, directory) => {
			const next = imageRecord(); const folder = path.join(directory, 'conversations-v2', createHash('sha256').update(next.summary.id).digest('hex'));
			const name = createHash('sha256').update(JSON.stringify(next.messages)).digest('hex') + '.json';
			await fsp.mkdir(folder, { recursive: true }); await fsp.mkdir(path.join(folder, `${name}.search`));
			await storage.save(next);
			assert.deepEqual({ saved: storage.load(next.summary.id), total: (await store.searchAsync({ query: 'hidden needle' })).total, notices: store.recoveryIssues.length }, { saved: next, total: 1, notices: 1 });
		});
	});

	test('quota failure writing a new text cache cannot prevent the authoritative manifest commit', async () => {
		await fixture(async (_store, storage, directory) => {
			const nativePromises = createRequire(import.meta.url)('node:fs/promises') as typeof fsp;
			const rename = nativePromises.rename; let cacheWrites = 0;
			Object.assign(nativePromises, { rename: async (source: fs.PathLike, destination: fs.PathLike) => {
				if (String(destination).endsWith('.search')) { cacheWrites++; throw Object.assign(new Error('Quota exceeded'), { code: 'EDQUOT' }); }
				return rename(source, destination);
			} });
			const next = imageRecord();
			try { await storage.save(next); } finally { Object.assign(nativePromises, { rename }); }
			const page = await messagePage(directory);
			assert.deepEqual({ saved: storage.load(next.summary.id), cacheWrites, cacheExists: fs.existsSync(`${page}.search`), staging: (await fsp.readdir(path.dirname(page))).filter(file => file.endsWith('.tmp')) }, { saved: next, cacheWrites: 1, cacheExists: false, staging: [] });
		});
	});

	test('read-only-style cache failure computes a worker match without a writable destination', async () => {
		await fixture(async (_store, storage, directory) => {
			await storage.save(imageRecord()); const page = await messagePage(directory);
			const result = await buildLegacySearchIndex(page, path.join(page, 'cannot-write-here.search'), 'hidden needle');
			assert.deepEqual({ matched: result.matched, cacheFailed: !!result.cacheError }, { matched: true, cacheFailed: true });
		});
	});

	test('oversized legacy pages remain intact and report unavailable indexing without blocking healthy histories', async () => {
		await fixture(async (store, storage, directory) => {
			await storage.save(imageRecord()); const page = await messagePage(directory); await fsp.rm(`${page}.search`);
			await fsp.truncate(page, 64 * 1024 * 1024 + 1);
			await storage.save(record('healthy', [text('hidden needle')]));
			assert.deepEqual({ ids: (await store.searchAsync({ query: 'hidden needle' })).items.map(item => item.id), oversizedPreserved: (await fsp.stat(page)).size, notices: store.recoveryIssues.map(issue => ({ path: issue.path, bounded: issue.message.includes('64 MiB') })) }, { ids: ['healthy'], oversizedPreserved: 64 * 1024 * 1024 + 1, notices: [{ path: page, bounded: true }] });
		});
	});

	test('the history palette awaits body search instead of invoking synchronous search', async () => {
		const originalPick = vscode.window.showQuickPick; const originalInput = vscode.window.showInputBox;
		let picks = 0; const queries: object[] = [];
		Object.assign(vscode.window, { showQuickPick: async () => ++picks === 1 ? { scope: 'archived' } : undefined, showInputBox: async () => 'hidden needle' });
		try {
			await new ConversationActions({ search: () => { throw new Error('Synchronous body search'); }, searchAsync: async (options: object) => { await new Promise<void>(resolve => setImmediate(resolve)); queries.push(options); return { items: [] }; } } as unknown as ConversationStore).manage();
			assert.deepEqual({ picks, queries }, { picks: 2, queries: [{ scope: 'archived', query: 'hidden needle', limit: Number.MAX_SAFE_INTEGER }] });
		} finally { Object.assign(vscode.window, { showQuickPick: originalPick, showInputBox: originalInput }); }
	});

	test('obsolete text indexes follow message-page collection after a committed replacement', async () => {
		await fixture(async (_store, storage, directory) => {
			await storage.save(imageRecord()); const original = await messagePage(directory);
			await storage.save(record('conversation', [text('Replacement body')]));
			const current = await messagePage(directory);
			assert.deepEqual({ originalPage: fs.existsSync(original), originalIndex: fs.existsSync(`${original}.search`), currentPage: fs.existsSync(current), currentIndex: fs.existsSync(`${current}.search`) }, { originalPage: false, originalIndex: false, currentPage: true, currentIndex: true });
		});
	});

	test('a damaged derived index is rebuilt but corrupt authoritative history remains an integrity failure', async () => {
		await fixture(async (store, storage, directory) => {
			await storage.save(imageRecord()); const page = await messagePage(directory);
			await fsp.writeFile(`${page}.search`, 'corrupt cache'); assert.equal((await store.searchAsync({ query: 'hidden needle' })).total, 1);
			await fsp.writeFile(page, 'corrupt history');
			assert.deepEqual({ result: (await store.searchAsync({ query: 'hidden needle' })).total, notice: store.recoveryIssues.map(issue => issue.path), retained: await fsp.readFile(page, 'utf8') }, { result: 0, notice: [page], retained: 'corrupt history' });
			assert.throws(() => storage.load('conversation'), /integrity/);
		});
	});
});
