/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { EventEmitter } from 'node:events';
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

test('named watcher events update one file while queries stay available; deletions rescan', { timeout: 15000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-incremental-'));
	let session, release;
	t.after(async () => { release?.(); session?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	const file = join(root, 'source.ts'); await writeFile(file, 'export const original = 1;');
	let scans = 0, updates = 0, notify;
	const watcher = Object.assign(new EventEmitter(), { close() {} });
	const engine = { init() {}, indexWorkspace: async () => { scans++; return { files: 1, symbols: 1, edges: 0, skippedUnchanged: 0 }; }, reindexFile: async () => { updates++; await new Promise(resolve => { release = resolve; }); return true; } };
	session = new EngineSession({ indexRoot: root, dbPath: join(root, '.graph/db'), embedder: { kind: 'none' } }, undefined, (_root, _options, listener) => { notify = listener; return watcher; }); await session.start(engine);
	const until = async predicate => { for (let index = 0; index < 100; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`Watcher did not settle: ${JSON.stringify({scans, updates, status: session.status})}`); };
	const initialScans = scans;
	await writeFile(file, 'export const updated = 2;'); notify('change', 'source.ts'); await until(() => updates > 0);
	assert.deepEqual([scans, session.status.structural, session.status.state], [initialScans, true, 'ready']); release();
	await new Promise(resolve => setTimeout(resolve, 100)); await unlink(file); notify('rename', 'source.ts'); await until(() => scans > initialScans);
	assert.equal(session.status.structural, true);
	const beforeUnknown = scans; notify('rename', null); await until(() => scans > beforeUnknown);
});

test('native watcher keeps indexed content current across edits and deletions', { timeout: 20000 }, async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-native-watch-'));
	const file = join(root, 'source.ts');
	let session;
	const indexed = new Map();
	t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
	await writeFile(file, 'before');
	const engine = {
		init() {},
		async indexWorkspace() { indexed.clear(); for (const name of await readdir(root)) { if (name.endsWith('.ts')) indexed.set(name, await readFile(join(root, name), 'utf8')); } return { files: indexed.size, symbols: indexed.size, edges: 0 }; },
		async reindexFile(filename) { indexed.set(basename(filename), await readFile(filename, 'utf8')); return true; }
	};
	session = new EngineSession({ indexRoot: root, dbPath: join(root, '.graph/db'), embedder: { kind: 'none' } });
	await session.start(engine);
	const until = async predicate => { for (let i = 0; i < 160; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } assert.fail(`Indexed content did not settle: ${JSON.stringify([...indexed])}`); };
	// Native macOS events can coalesce into a root rescan. Assert content,
	// while the injected-event test above verifies the incremental path.
	await writeFile(file, 'after'); await until(() => indexed.get('source.ts') === 'after');
	await unlink(file); await until(() => !indexed.has('source.ts'));
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

test('failed initialization disposes its engine once and keeps the failure visible', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-failed-init-'));
	let disposed = 0, indexed = 0;
	const session = new EngineSession({ indexRoot: root, dbPath: join(root, 'graph.db') }, () => {});
	t.after(async () => { session.dispose(); await rm(root, { recursive: true, force: true }); });
	await session.start({ init: async () => { throw new Error('Database cannot open'); }, dispose: () => { disposed++; }, indexWorkspace: async () => { indexed++; } });
	await session.refresh(); session.dispose();
	assert.deepEqual([session.status.state, session.status.structural, disposed, indexed], ['failed', false, 1, 0]);
	assert.match(session.status.reason, /Database cannot open/);
});
