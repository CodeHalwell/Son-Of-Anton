/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { ConversationStore } from '../src/chat/ConversationStore';
import { ConversationStorage } from '../src/chat/ConversationStorage';
import type { ChatMessage } from '../src/chat/ChatPanel';

class Memento implements vscode.Memento {
	private readonly values = new Map<string, unknown>();
	get<T>(key: string, fallback?: T): T { return (this.values.get(key) ?? fallback) as T; }
	keys(): string[] { return [...this.values.keys()]; }
	async update(key: string, value: unknown): Promise<void> { if (value === undefined) { this.values.delete(key); } else { this.values.set(key, structuredClone(value)); } }
}
function message(content: string): ChatMessage { return { role: 'assistant', content, timestamp: 1 }; }
async function fixture(disk: boolean, run: (store: ConversationStore, directory: string, context: vscode.ExtensionContext) => Promise<void>): Promise<void> {
	const directory = await fs.mkdtemp(path.join(tmpdir(), 'sota-one-message-'));
	const context = { globalState: new Memento(), workspaceState: new Memento(), ...(disk ? { globalStorageUri: vscode.Uri.file(directory) } : {}) } as unknown as vscode.ExtensionContext;
	const store = new ConversationStore(context);
	try { await store.ready; await run(store, directory, context); }
	finally { store.dispose(); await store.flush().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); }
}

suite('Bounded conversation message lookup', () => {
	test('reads only the requested disk page and reports corruption only when that page is requested', async () => {
		await fixture(true, async (store, directory) => {
			const messages: ChatMessage[] = Array.from({ length: 201 }, (_, index) => message(`Response ${index}`));
			messages[0] = { role: 'user', content: [{ type: 'image', mimeType: 'image/png', base64Data: 'A'.repeat(512 * 1024) }], timestamp: 0 };
			const record = store.create(messages); await store.flush();
			const folder = path.join(directory, 'conversations-v2', createHash('sha256').update(record.summary.id).digest('hex'));
			const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8')) as { pages: string[] };
			const damaged = path.join(folder, manifest.pages[0]); await fs.writeFile(damaged, 'damaged unrelated image page');
			assert.deepEqual(store.loadMessage(record.summary.id, 150), messages[150]);
			assert.equal(store.recoveryIssues.length, 0);
			assert.throws(() => store.loadMessage(record.summary.id, 0), /integrity check/);
			assert.deepEqual(store.recoveryIssues.map(issue => issue.path), [damaged]);
		});
	});

	for (const disk of [true, false]) {
		test(`${disk ? 'disk' : 'Memento'} lookup uses pending data, validates indices, and excludes Trash or permanent deletion`, async () => {
			await fixture(disk, async store => {
				const messages = [message('first'), message('latest pending')]; const record = store.create(messages); const id = record.summary.id;
				assert.deepEqual(store.loadMessage(id, 1), messages[1]);
				for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2]) { assert.equal(store.loadMessage(id, index), undefined); }
				await store.flush(); assert.deepEqual(store.loadMessage(id, 1), messages[1]);
				store.delete(id); assert.equal(store.loadMessage(id, 1), undefined); await store.flush(); assert.equal(store.loadMessage(id, 1), undefined);
				store.restore(id); assert.deepEqual(store.loadMessage(id, 1), messages[1]); await store.flush();
				store.delete(id); store.permanentDelete(id); assert.equal(store.loadMessage(id, 1), undefined); await store.flush(); assert.equal(store.loadMessage(id, 1), undefined);
			});
		});
	}

	test('external tombstones hide pending copies and damaged markers retain their recovery error', async () => {
		await fixture(true, async (store, directory) => {
			const deleted = store.create([message('delete externally')]); const damaged = store.create([message('retain damaged')]); await store.flush();
			const root = path.join(directory, 'conversations-v2');
			store.update(deleted.summary.id, [message('pending stale content')]);
			await new ConversationStorage(root).delete(deleted.summary.id);
			assert.equal(store.loadMessage(deleted.summary.id, 0), undefined); await store.flush();
			const marker = path.join(root, '.lifecycle', createHash('sha256').update(damaged.summary.id).digest('hex'), 'deletion.json');
			await fs.writeFile(marker, '{damaged');
			assert.throws(() => store.loadMessage(damaged.summary.id, 0));
			assert.ok(store.recoveryIssues.some(issue => issue.path === marker));
		});
	});
});
