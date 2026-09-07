/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineSession } from '../dist/engine.js';
test('file watcher updates one file while queries stay available; deletions rescan', { timeout: 15000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-incremental-')); t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, 'source.ts'); await writeFile(file, 'export const original = 1;');
	let scans = 0, updates = 0, release;
	const engine = { init() {}, indexWorkspace: async () => { scans++; return { files: 1, symbols: 1, edges: 0, skippedUnchanged: 0 }; }, reindexFile: async () => { updates++; await new Promise(resolve => { release = resolve; }); return true; } };
	const session = new EngineSession({ indexRoot: root, dbPath: join(root, '.graph/db'), embedder: { kind: 'none' } }); t.after(() => session.dispose()); await session.start(engine);
	const until = async predicate => { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Watcher did not settle: ${JSON.stringify({scans, updates, status: session.status})}`); };
	await new Promise(resolve => setTimeout(resolve, 500));
	const initialScans = scans;
	await writeFile(file, 'export const updated = 2;'); await until(() => updates > 0);
	assert.deepEqual([scans, session.status.structural, session.status.state], [initialScans, true, 'ready']); release();
	await new Promise(resolve => setTimeout(resolve, 100)); await unlink(file); await until(() => scans > initialScans);
	assert.equal(session.status.structural, true);
});
