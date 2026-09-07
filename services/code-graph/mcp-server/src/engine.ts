/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';

export interface SearchHit {
  symbol: string;
  file: string;
  kind: string;
  snippet: string;
  score: number;
}

export interface FileSummary {
  path: string;
  language: string;
  symbols: Array<{
    name: string;
    kind: string;
    docString?: string | null;
    start: number;
    end: number;
  }>;
}

export interface SymbolMatch {
  name: string;
  kind: string;
  file: string;
  start: number;
  end: number;
}

export interface Reference {
  fromFile: string;
  toSymbol: string;
  toFile: string;
  kind: string;
}

export interface IndexStats {
  files: number;
  symbols: number;
  edges: number;
  skippedUnchanged: number;
}

/** The subset of the Rust napi surface this server uses. */
export interface CodegraphEngine {
  init(dbPath: string): void;
  configureLocalEmbedder?(): void;
  configureProviderEmbedder?(
    endpoint: string,
    model: string,
    dims: number,
    apiKey?: string,
  ): void;
  indexWorkspace(root: string): Promise<IndexStats>;
  reindexFile(path: string): Promise<boolean>;
  embedAll(batchSize: number): Promise<number>;
  buildVectorIndex(): number;
  semanticSearch(
    query: string,
    limit: number,
    scope?: string[],
  ): Promise<SearchHit[]>;
  fileSummary(path: string): FileSummary;
  symbolLookup(query: string, limit: number): SymbolMatch[];
  dependencyTraversal(startFile: string, maxDepth: number): string[];
  impactAnalysis(targetFile: string, maxDepth: number): string[];
  findReferences(symbolName: string): Reference[];
}

export interface EngineConfig {
  dbPath: string;
  /** If set, automatically index this directory at startup. */
  indexRoot?: string;
  embedder?:
    | { kind: 'none' }
    | { kind: 'local' }
    | {
        kind: 'provider';
        endpoint: string;
        model: string;
        dims: number;
        apiKey?: string;
      };
}

export interface EngineStatus {
	state: 'starting' | 'ready' | 'degraded' | 'failed';
	structural: boolean;
	semantic: 'disabled' | 'building' | 'ready' | 'empty' | 'error';
	reason?: string;
	indexedAt?: number;
	stats?: IndexStats;
}

/** One engine and watcher per serving process; startup failures remain visible through MCP. */
export class EngineSession {
	engine: CodegraphEngine | undefined;
	status: EngineStatus = { state: 'starting', structural: false, semantic: 'disabled' };
	private watcher?: FSWatcher;
	private timer?: NodeJS.Timeout;
	private updating?: Promise<void>;
	private dirty = false;
	private fullRefresh = true;
	private readonly changedPaths = new Set<string>();
	private disposed = false;
	private embedderConfigured = false;

	constructor(private readonly config: EngineConfig, private readonly changed: (status: EngineStatus) => void = () => {}) { }

	private publish(status: EngineStatus): void {
		this.status = status;
		this.changed(status);
	}

	async start(injected?: CodegraphEngine): Promise<void> {
		try {
			if (!this.config.indexRoot) { throw new Error('Open a workspace or pass --index-root=<directory>.'); }
			this.config.indexRoot = await realpath(this.config.indexRoot);
			await mkdir(path.dirname(this.config.dbPath), { recursive: true });
			const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
			this.engine = injected ?? require(process.env.CODEGRAPH_NAPI_PATH || '@son-of-anton/codegraph-napi') as CodegraphEngine;
			this.engine.init(this.config.dbPath);
			await this.refresh();
			if (!this.status.structural || this.disposed) { return; }
			this.watcher = watch(this.config.indexRoot, { recursive: true }, (_event, filename) => {
				if (!filename) { this.scheduleRefresh(); return; }
				const name = filename.toString().replace(/\\/g, '/');
				if (/(^|\/)(node_modules|target|dist|out)(\/|$)/.test(name)) { return; }
				if (name.startsWith('.git/') && !/^\.git\/(HEAD|index|refs\/)/.test(name)) { return; }
				if (path.resolve(this.config.indexRoot!, name).startsWith(this.config.dbPath)) { return; }
				this.scheduleRefresh(name.startsWith('.git/') ? undefined : name);
			});
			this.watcher.on('error', error => this.publish({ ...this.status, state: 'degraded', reason: `File watcher failed: ${error.message}. Restart code graph.` }));
		} catch (error) {
			this.publish({ state: 'failed', structural: false, semantic: 'disabled', reason: `Code graph could not start: ${this.message(error)}. Run sota doctor to check bundled assets.` });
		}
	}

	private message(error: unknown): string {
		const message = error instanceof Error ? error.message : String(error);
		const key = this.config.embedder?.kind === 'provider' ? this.config.embedder.apiKey : undefined;
		return key ? message.split(key).join('[redacted]') : message;
	}

	private scheduleRefresh(file?: string): void {
		if (this.disposed) { return; }
		this.dirty = true;
		if (!file || this.changedPaths.size >= 256) { this.fullRefresh = true; this.changedPaths.clear(); }
		else if (!this.fullRefresh) { this.changedPaths.add(file); }
		if (this.timer) { clearTimeout(this.timer); }
		this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(false); }, 350);
	}

	async refresh(full = true): Promise<void> {
		if (this.disposed || !this.engine || !this.config.indexRoot) { return; }
		if (full) { this.fullRefresh = true; }
		if (this.updating) { this.dirty = true; return this.updating; }
		this.dirty = false;
		const files = this.fullRefresh ? undefined : [...this.changedPaths]; this.changedPaths.clear(); this.fullRefresh = false;
		this.updating = this.update(files);
		try { await this.updating; }
		finally { this.updating = undefined; if (this.dirty && !this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(false); }, 350); } }
	}

	private async update(files?: string[]): Promise<void> {
		const engine = this.engine!;
		this.publish({ ...this.status, state: this.status.structural ? 'ready' : 'starting', structural: this.status.structural, semantic: this.embedderConfigured ? 'building' : 'disabled', reason: undefined });
		try {
			// Native per-file indexing does not return aggregate counts. Do not label old totals as current.
			let stats: IndexStats | undefined;
			let incremental = !!files?.length && this.status.structural;
			if (incremental) {
				for (const file of files!) {
					const absolute = path.resolve(this.config.indexRoot!, file);
					const info = await stat(absolute).catch(() => undefined);
					if (!info?.isFile() || !await engine.reindexFile(absolute)) { incremental = false; break; }
				}
			}
			if (!incremental) { stats = await engine.indexWorkspace(this.config.indexRoot!); }
			const structural: EngineStatus = { state: 'ready', structural: true, semantic: 'disabled', indexedAt: Date.now(), stats };
			this.publish(structural);
			const embedder = this.config.embedder;
			if (!embedder || embedder.kind === 'none') { return; }
			this.publish({ ...structural, semantic: 'building' });
			try {
				if (!this.embedderConfigured && embedder.kind === 'local') {
					if (!engine.configureLocalEmbedder) { throw new Error('Local embedder is not included in this native build'); }
					engine.configureLocalEmbedder();
				} else if (!this.embedderConfigured && embedder.kind === 'provider') {
					if (!engine.configureProviderEmbedder) { throw new Error('Provider embedder is not included in this native build'); }
					engine.configureProviderEmbedder(embedder.endpoint, embedder.model, embedder.dims, embedder.apiKey);
				}
				this.embedderConfigured = true;
				await engine.embedAll(64);
				const count = engine.buildVectorIndex();
				this.publish({ ...structural, semantic: count ? 'ready' : 'empty' });
			} catch (error) {
				this.publish({ ...structural, state: 'degraded', semantic: 'error', reason: `Embedding failed: ${this.message(error)}. Check the embedding endpoint, model and credentials.` });
			}
		} catch (error) {
			this.publish({ state: 'failed', structural: false, semantic: 'error', reason: `Indexing failed: ${this.message(error)}` });
		}
	}

	dispose(): void {
		this.disposed = true;
		this.watcher?.close();
		if (this.timer) { clearTimeout(this.timer); }
	}
}
