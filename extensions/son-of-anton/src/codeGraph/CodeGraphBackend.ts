/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

export type CodeGraphBackendState = 'off' | 'starting' | 'embedded' | 'docker' | 'degraded' | 'failed';
export type CodeGraphEmbedderMode = 'none' | 'local' | 'provider';
export type CodeGraphBackendChoice = 'auto' | 'embedded' | 'docker' | 'off';

export interface CodeGraphBackendOptions {
	readonly workspaceRoot: string | undefined;
	readonly getWorkspaceRoot?: () => string | undefined;
	readonly repoRoot: string;
	readonly extensionPath?: string;
	readonly storageDir: string;
	readonly output: vscode.OutputChannel;
	readonly getConfiguration?: () => vscode.WorkspaceConfiguration;
}

export interface McpServerEntry {
	readonly name: string;
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
}

/** Describes the bundled server; McpClient exclusively owns the serving child. */
export class CodeGraphBackend implements vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<CodeGraphBackendState>();
	readonly onDidChangeState = this.changes.event;
	private state: CodeGraphBackendState = 'off';
	private descriptor?: McpServerEntry;
	private disposed = false;
	private restartToken = 0;
	private configurationGeneration = 0;
	private retries = 0;
	private retryTimer?: NodeJS.Timeout;
	private stderr = '';
	private lastIndexAt?: number;
	private lastSymbolCount?: number;
	private lastFileCount?: number;
	private reason?: string;
	private semantic = 'disabled';

	constructor(private readonly options: CodeGraphBackendOptions) { }
	get currentState(): CodeGraphBackendState { return this.state; }
	get lastIndexedAt(): number | undefined { return this.lastIndexAt; }
	get symbolCount(): number | undefined { return this.lastSymbolCount; }
	get fileCount(): number | undefined { return this.lastFileCount; }
	get failureReason(): string | undefined { return this.reason; }
	get semanticState(): string { return this.semantic; }
	getMcpServerEntry(): McpServerEntry | undefined { return this.descriptor; }

	async start(): Promise<void> {
		this.retries = 0;
		await this.configure();
	}

	private async configure(): Promise<void> {
		if (this.disposed) { return; }
		const generation = ++this.configurationGeneration;
		this.lastIndexAt = undefined;
		this.lastFileCount = undefined;
		this.lastSymbolCount = undefined;
		this.semantic = 'disabled';
		if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
		this.descriptor = undefined;
		this.stderr = '';
		const config = this.options.getConfiguration?.() ?? vscode.workspace.getConfiguration('sota.codeGraph');
		const choice = config.get<CodeGraphBackendChoice>('backend', 'auto');
		const workspace = this.options.getWorkspaceRoot?.() ?? this.options.workspaceRoot;
		if (choice === 'off' || !workspace) { this.setState('off'); return; }
		if (choice === 'docker') {
			this.setState('degraded', 'Connect the optional Docker gateway through sota.mcp.servers, or select the embedded backend.');
			return;
		}
		try {
			const workspaceRoot = await fs.promises.realpath(workspace);
			const explicit = config.get<string>('indexRoot', '').trim();
			const root = explicit ? await fs.promises.realpath(path.resolve(workspaceRoot, explicit)) : workspaceRoot;
			if (root !== workspaceRoot && !root.startsWith(workspaceRoot + path.sep)) { throw new Error('The index root must be inside the open workspace.'); }
			const entry = this.serverEntryPath();
			if (!entry) { throw new Error('Bundled code graph is missing. Run npm run bootstrap:sota in a development checkout, or reinstall the application.'); }
			const storage = path.join(this.options.storageDir, 'codegraph', createHash('sha256').update(root).digest('hex'));
			await fs.promises.mkdir(storage, { recursive: true });
			const args = [entry, '--backend=embedded', `--index-root=${root}`, `--db=${path.join(storage, 'graph.db')}`, `--restart-token=${++this.restartToken}`];
			const embedder = config.get<CodeGraphEmbedderMode>('embedder', 'none');
			if (embedder === 'local') { args.push('--local-embedder'); }
			if (embedder === 'provider') {
				const endpoint = config.get<string>('providerEmbedder.endpoint', '');
				const model = config.get<string>('providerEmbedder.model', '');
				const dims = config.get<number>('providerEmbedder.dims', 1536);
				if (!endpoint || !model || !Number.isInteger(dims) || dims < 1) { throw new Error('Configure the embedding endpoint, model and dimensions.'); }
				args.push(`--provider-embedder=${endpoint}|${model}|${dims}`);
			}
			if (this.disposed || generation !== this.configurationGeneration) { return; }
			this.descriptor = { name: 'code-graph', command: process.execPath, args, cwd: root, env: { ELECTRON_RUN_AS_NODE: '1' } };
			this.setState('starting');
		} catch (error) { if (!this.disposed && generation === this.configurationGeneration) { this.setState('failed', error instanceof Error ? error.message : String(error)); } }
	}

	/** Receives lifecycle events from the production MCP connection. */
	connectionState(state: string, error?: string): void {
		if (this.disposed || !this.descriptor) { return; }
		if (state === 'connecting') { this.setState('starting'); }
		if (state === 'closed' || state === 'error') {
			this.setState('failed', error || 'The code graph process disconnected.');
			if (!this.retryTimer && this.retries < 3) {
				const delay = [1000, 4000, 16000][this.retries++];
				this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.configure(); }, delay);
			}
		}
	}

	/** Stderr status frames originate from that same serving process. */
	acceptLog(chunk: string): void {
		this.options.output.append(chunk);
		this.stderr = (this.stderr + chunk).slice(-65536);
		let end: number;
		while ((end = this.stderr.indexOf('\n')) >= 0) {
			const line = this.stderr.slice(0, end);
			this.stderr = this.stderr.slice(end + 1);
			if (!line.startsWith('[codegraph-status] ')) { continue; }
			try {
				const status = JSON.parse(line.slice('[codegraph-status] '.length)) as Record<string, unknown>;
				if (!['starting', 'ready', 'degraded', 'failed'].includes(String(status.state)) || typeof status.structural !== 'boolean' || typeof status.semantic !== 'string') { continue; }
				this.semantic = status.semantic;
				if (typeof status.indexedAt === 'number' && Number.isFinite(status.indexedAt)) { this.lastIndexAt = status.indexedAt; }
				const stats = status.stats as { totalFiles?: number; totalSymbols?: number } | undefined;
				if (stats && typeof stats.totalFiles === 'number' && typeof stats.totalSymbols === 'number') { this.lastFileCount = stats.totalFiles; this.lastSymbolCount = stats.totalSymbols; }
				this.setState(status.state === 'ready' && status.structural ? 'embedded' : status.state as CodeGraphBackendState, typeof status.reason === 'string' ? status.reason : undefined);
			} catch { /* Ignore malformed diagnostic output. */ }
		}
	}

	serverEntryPath(): string | undefined {
		const candidates = [
			...(this.options.extensionPath ? [path.join(this.options.extensionPath, 'runtime/codegraph/index.cjs')] : []),
			path.join(this.options.repoRoot, 'services/code-graph/mcp-server/dist/index.js'),
		];
		return candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
	}
	async restart(): Promise<void> { await this.start(); }
	async indexWorkspace(): Promise<void> { await this.start(); }
	openLogs(): void { this.options.output.show(true); }
	private setState(state: CodeGraphBackendState, reason?: string): void {
		this.state = state;
		this.reason = reason;
		this.changes.fire(state);
	}
	dispose(): void {
		this.disposed = true;
		this.descriptor = undefined;
		if (this.retryTimer) { clearTimeout(this.retryTimer); }
		this.changes.dispose();
	}
}
