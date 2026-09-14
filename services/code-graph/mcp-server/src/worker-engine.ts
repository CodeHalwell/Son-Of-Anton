/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as path from 'node:path';
import { fork } from 'node:child_process';
import type { CodegraphEngine } from './engine.js';
import type { EngineMethod, EngineReply, EngineRequest } from './engine-worker.js';

/** Keep native module loading, SQLite locks and vector construction off the MCP event loop. */
export function createWorkerEngine(failed: (error: Error) => void): CodegraphEngine {
	const entry = typeof __filename === 'string' ? path.join(path.dirname(__filename), 'engine-worker.cjs') : new URL('./engine-worker.js', import.meta.url);
	// A process boundary also lets us interrupt an uncooperative native download.
	const worker = fork(entry, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', execArgv: [] });
	// Third-party diagnostic output must never be interpreted as MCP JSON on stdout.
	worker.stdout?.on('data', chunk => process.stderr.write(chunk));
	worker.stderr?.on('data', chunk => process.stderr.write(chunk));
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let sequence = 0;
	let stopped: Error | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	const stop = (error: Error, unexpected = false): void => {
		if (stopped) { return; }
		stopped = error;
		for (const request of pending.values()) { request.reject(error); }
		pending.clear();
		if (worker.exitCode === null && worker.signalCode === null) {
			worker.kill('SIGTERM');
			killTimer = setTimeout(() => { worker.kill('SIGKILL'); }, 1000);
			killTimer.unref();
		}
		if (unexpected) { failed(error); }
	};
	worker.on('error', error => stop(error, true));
	worker.on('disconnect', () => stop(new Error('Native code graph worker disconnected'), true));
	worker.on('exit', (code, signal) => {
		if (killTimer) { clearTimeout(killTimer); }
		stop(new Error(`Native code graph worker exited (${signal ?? code})`), true);
	});
	worker.on('message', (reply: EngineReply) => {
		const request = pending.get(reply.id);
		if (!request) { return; }
		pending.delete(reply.id);
		if (reply.error !== undefined) { request.reject(new Error(reply.error)); }
		else { request.resolve(reply.value); }
	});
	const call = <T>(method: EngineMethod, args: unknown[]): Promise<T> => {
		if (stopped) { return Promise.reject(stopped); }
		if (pending.size >= 256) { return Promise.reject(new Error('Code graph is busy; retry after pending requests finish')); }
		return new Promise<T>((resolve, reject) => {
			const id = ++sequence;
			pending.set(id, { resolve: value => resolve(value as T), reject });
			try {
				worker.send({ id, method, args } satisfies EngineRequest, error => {
					if (error) { pending.delete(id); reject(error); }
				});
			}
			catch (error) { pending.delete(id); reject(error); }
		});
	};
	return {
		init: database => call('init', [database]),
		configureLocalEmbedder: cache => call('configureLocalEmbedder', [cache]),
		configureProviderEmbedder: (endpoint, model, dims, key) => call('configureProviderEmbedder', [endpoint, model, dims, key]),
		indexWorkspace: root => call('indexWorkspace', [root]),
		reindexFile: file => call('reindexFile', [file]),
		embedAll: size => call('embedAll', [size]),
		buildVectorIndex: () => call('buildVectorIndex', []),
		semanticSearch: (query, limit, scope) => call('semanticSearch', [query, limit, scope]),
		fileSummary: file => call('fileSummary', [file]),
		symbolLookup: (query, limit) => call('symbolLookup', [query, limit]),
		dependencyTraversal: (file, depth) => call('dependencyTraversal', [file, depth]),
		impactAnalysis: (file, depth) => call('impactAnalysis', [file, depth]),
		findReferences: name => call('findReferences', [name]),
		dispose: () => stop(new Error('Code graph session closed'))
	};
}
