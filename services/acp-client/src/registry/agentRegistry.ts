// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

import { readFile, watch } from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';
import { validateAgent, object } from '../../_shared/acp/dist/acp/protocol';
import type {
	AgentRegistryConfig,
	AgentRegistryEntry,
	AgentDescriptor,
	AgentCapabilities,
} from '../types';

/**
 * Manages agent registration from the acp-agents.json configuration file.
 *
 * Watches for changes and emits 'change' events when agents are added or removed.
 * New agents are added by editing the config file — no code changes required.
 */
export class AgentRegistry extends EventEmitter {
	private agents = new Map<string, AgentRegistryEntry>();

	private watchAbort: AbortController | null = null;
	private revision = 0;

	constructor(private readonly configPath: string) {
		super();
	}

	/** Load agents from the configuration file. */
	async load(): Promise<void> {
		const revision = ++this.revision;
		try {
			const raw = await readFile(this.configPath, 'utf-8');
			if (Buffer.byteLength(raw) > 1024 * 1024) { throw new Error('ACP registry exceeds 1 MiB'); }
			const config: AgentRegistryConfig = JSON.parse(raw);
			if (!object(config) || !Array.isArray(config.agents) || config.agents.length > 64) { throw new Error('ACP registry requires an agents array with at most 64 entries'); }
			const next = new Map<string, AgentRegistryEntry>();
			for (const entry of config.agents) {
				this.validateEntry(entry);
				if (next.has(entry.id)) { throw new Error(`Duplicate ACP agent id: ${entry.id}`); }
				next.set(entry.id, entry);
			}
			if (revision !== this.revision) { return; }
			this.agents = next;

			this.emit('loaded', this.listDescriptors());
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				console.warn(`[acp-registry] Config file not found: ${this.configPath}`);
				return;
			}
			throw err;
		}
	}

	/** Start watching the config file for changes. */
	async startWatching(): Promise<void> {
		if (this.watchAbort) { return; }
		this.watchAbort = new AbortController();
		const dir = path.dirname(this.configPath);
		const filename = path.basename(this.configPath);

		try {
			const watcher = watch(dir, { signal: this.watchAbort.signal });
			for await (const event of watcher) {
				if (typeof event === 'object' && event !== null && 'filename' in event) {
					const fileEvent = event as { eventType: string; filename: string };
					if (fileEvent.filename === filename) {
						console.log('[acp-registry] Config file changed, reloading...');
						try { await this.load(); this.emit('change', this.listDescriptors()); }
						catch (error) { this.emit('reloadError', error); }
					}
				}
			}
		} catch (err) {
			if ((err as Error).name !== 'AbortError') {
				console.error('[acp-registry] Watch error:', err);
			}
		}
	}

	/** Stop watching the config file. */
	stopWatching(): void {
		this.watchAbort?.abort();
		this.watchAbort = null;
	}

	/** Get all registered agent descriptors. */
	listDescriptors(): AgentDescriptor[] {
		return Array.from(this.agents.values()).map(entry => ({
			id: entry.id,
			name: entry.name,
			transport: entry.transport,
			capabilities: [...entry.capabilities],
			contextWindow: entry.contextWindow,
			costTier: entry.costTier,
		}));
	}

	/** Get a specific agent entry by ID. */
	getEntry(agentId: string): AgentRegistryEntry | undefined {
		const entry = this.agents.get(agentId);
		return entry ? structuredClone(entry) : undefined;
	}

	/** Check if an agent is registered. */
	has(agentId: string): boolean {
		return this.agents.has(agentId);
	}

	/** Build a capabilities response from a registry entry (before connecting). */
	static entryToCapabilities(entry: AgentRegistryEntry): AgentCapabilities {
		return {
			agentId: entry.id,
			capabilities: [...entry.capabilities],
			supportsPause: false,
			supportsResume: false,
		};
	}

	private validateEntry(entry: AgentRegistryEntry): void {
		if (!object(entry)) { throw new Error('Agent entry must be an object'); }
		if (entry.transport !== 'stdio') { throw new Error('ACP agents must use stdio; the former /rpc + /events HTTP transport was not standard ACP'); }
		validateAgent(entry);
		if (typeof entry.name !== 'string' || !entry.name.trim()) { throw new Error(`Agent ${entry.id}: must have a name`); }
		if (!Array.isArray(entry.capabilities) || !entry.capabilities.every(capability => typeof capability === 'string')) { throw new Error(`Agent ${entry.id}: must have a capabilities array`); }
		if (!['free', 'subscription', 'pay-per-use', 'local'].includes(entry.costTier)) { throw new Error(`Agent ${entry.id}: invalid costTier`); }
	}
}
