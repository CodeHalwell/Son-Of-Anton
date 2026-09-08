/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rm, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineSession } from '../dist/engine.js';
test('file watcher updates one file while queries stay available; deletions rescan', { timeout: 15000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-incremental-'));
	let session;
	t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	const file = join(root, 'source.ts'); await writeFile(file, 'export const original = 1;');
	let scans = 0, updates = 0, release;
	const engine = { init() {}, indexWorkspace: async () => { scans++; return { files: 1, symbols: 1, edges: 0, skippedUnchanged: 0 }; }, reindexFile: async () => { updates++; await new Promise(resolve => { release = resolve; }); return true; } };
	session = new EngineSession({ indexRoot: root, dbPath: join(root, '.graph/db'), embedder: { kind: 'none' } }); await session.start(engine);
	const until = async predicate => { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Watcher did not settle: ${JSON.stringify({scans, updates, status: session.status})}`); };
	await new Promise(resolve => setTimeout(resolve, 500));
	const initialScans = scans;
	await writeFile(file, 'export const updated = 2;'); await until(() => updates > 0);
	assert.deepEqual([scans, session.status.structural, session.status.state], [initialScans, true, 'ready']); release();
	await new Promise(resolve => setTimeout(resolve, 100)); await unlink(file); await until(() => scans > initialScans);
	assert.equal(session.status.structural, true);
});

test('watcher records edits during the initial scan and ignores a relative SQLite database path', { timeout: 15000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-initial-watch-'));
	let session, release;
	t.after(async () => { release?.(); session?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	const file = join(root, 'source.ts'), database = join(root, 'codegraph.db');
	await writeFile(file, 'export const before = 1;');
	let scans = 0, updates = 0, initialized;
	const engine = { init(value) { initialized = value; }, indexWorkspace: async () => { scans++; await new Promise(resolve => { release = resolve; }); return { files: 1, symbols: 1, edges: 0, skippedUnchanged: 0 }; }, reindexFile: async () => { updates++; return true; } };
	session = new EngineSession({ indexRoot: root, dbPath: relative(process.cwd(), database), embedder: { kind: 'none' } });
	const started = session.start(engine);
	const until = async predicate => { for (let index = 0; index < 100; index++) { if (predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Watcher did not observe the edit'); };
	await until(() => scans === 1);
	await writeFile(file, 'export const after = 2;');
	await new Promise(resolve => setTimeout(resolve, 450));
	release(); await started; await until(() => updates === 1);
	for (const suffix of ['', '-wal', '-shm', '-journal']) { await writeFile(database + suffix, 'SQLite fixture'); }
	await new Promise(resolve => setTimeout(resolve, 800));
	assert.deepEqual({ scans, updates, initialized }, { scans: 1, updates: 1, initialized: join(await realpath(root), 'codegraph.db') });
	await writeFile(database + '.ts', 'export const legitimateSource = 1;');
	await until(() => updates === 2);
});
