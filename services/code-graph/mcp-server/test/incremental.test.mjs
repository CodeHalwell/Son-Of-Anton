/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink, rm, realpath } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineSession } from '../dist/engine.js';

test('local initialization is awaited while structural queries remain available and cache writes are ignored', { timeout: 15000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-local-init-'));
	let session, release, cache, scans = 0, embedded = 0;
	t.after(async () => { release?.(); session?.dispose(); await rm(root, { recursive: true, force: true }); });
	const engine = {
		init() {},
		async indexWorkspace() { scans++; return { files: 1, symbols: 1, edges: 0, skippedUnchanged: 0 }; },
		async configureLocalEmbedder(directory) { cache = directory; await new Promise(resolve => { release = resolve; }); },
		async embedAll() { embedded++; },
		buildVectorIndex() { return 1; },
		symbolLookup() { return [{ name: 'cartTotal' }]; }
	};
	session = new EngineSession({ indexRoot: root, dbPath: join(root, 'graph.db'), embedder: { kind: 'local' } });
	const started = session.start(engine);
	while (!release) { await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.deepEqual([session.status.structural, session.status.semantic, embedded, session.engine.symbolLookup()[0].name], [true, 'building', 0, 'cartTotal']);
	assert.equal(cache, join(await realpath(root), 'graph.db.models'));
	await mkdir(cache); await writeFile(join(cache, 'model.onnx'), 'model download');
	await new Promise(resolve => setTimeout(resolve, 800));
	release(); await started;
	await new Promise(resolve => setTimeout(resolve, 800));
	// macOS may coalesce the initial directory creation into a root rescan.
	const baseline = { scans, embedded };
	await writeFile(join(cache, 'model.onnx'), 'next model download chunk');
	await new Promise(resolve => setTimeout(resolve, 800));
	assert.deepEqual({ scans, embedded, semantic: session.status.semantic }, { ...baseline, semantic: 'ready' });
});

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

test('watcher records edits during the initial scan and ignores a relative SQLite database path', { timeout: 20000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-initial-watch-'));
	let session, release;
	t.after(async () => { release?.(); session?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	const file = join(root, 'source.ts'), database = join(root, 'codegraph.db');
	await writeFile(file, 'export const before = 1;');
	let scans = 0, updates = 0, initialized, indexed = new Map();
	const engine = {
		init(value) { initialized = value; },
		async indexWorkspace() {
			scans++;
			const snapshot = new Map();
			for (const name of await readdir(root)) { if (name.endsWith('.ts')) { snapshot.set(name, await readFile(join(root, name), 'utf8')); } }
			// Only the initial scan is paused. macOS may request a full rescan when
			// directory events are coalesced or a watcher event has no filename.
			if (scans === 1) { await new Promise(resolve => { release = resolve; }); }
			indexed = snapshot;
			return { files: snapshot.size, symbols: snapshot.size, edges: 0, skippedUnchanged: 0 };
		},
		async reindexFile(filename) { updates++; indexed.set(basename(filename), await readFile(filename, 'utf8')); return true; }
	};
	session = new EngineSession({ indexRoot: root, dbPath: relative(process.cwd(), database), embedder: { kind: 'none' } });
	const started = session.start(engine);
	const until = async predicate => { for (let index = 0; index < 160; index++) { if (predicate()) { return; } await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Watcher did not observe the edit: ${JSON.stringify({ scans, updates, indexed: [...indexed], status: session.status })}`); };
	await until(() => !!release);
	await writeFile(file, 'export const after = 2;');
	await new Promise(resolve => setTimeout(resolve, 450));
	release(); await started; await until(() => indexed.get('source.ts') === 'export const after = 2;');
	// Allow startup directory events to settle before measuring database-only writes.
	await new Promise(resolve => setTimeout(resolve, 1000));
	const baseline = { scans, updates };
	for (const suffix of ['', '-wal', '-shm', '-journal']) { await writeFile(database + suffix, 'SQLite fixture'); }
	await new Promise(resolve => setTimeout(resolve, 800));
	assert.deepEqual({ scans, updates, initialized }, { ...baseline, initialized: join(await realpath(root), 'codegraph.db') });
	await writeFile(database + '.ts', 'export const legitimateSource = 1;');
	await until(() => indexed.get('codegraph.db.ts') === 'export const legitimateSource = 1;');
});
