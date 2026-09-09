/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ConversationRecord, ConversationSummary } from './ConversationStore';
import type { ChatMessage } from './ChatPanel';
import { buildLegacySearchIndex, searchIndexMatches, writeSearchIndex } from './ConversationSearchIndex';

interface Manifest { version: 1; summary: ConversationSummary; pages: string[] }
const PAGE_SIZE = 100;
const PAGE_NAME = /^[a-f0-9]{64}\.json$/;
const OWNER_FILE = /^\.(reader|writer|gc)-(\d+)-[a-f0-9-]+$/;
const hostProcess = process as NodeJS.Process;
export interface ConversationRecoveryIssue { readonly path: string; readonly message: string }

/** Immutable message pages with an atomically replaced manifest; no shared index can lose another window's conversation. */
export class ConversationStorage {
	constructor(private readonly directory: string, private readonly onRecoveryIssue: (issue: ConversationRecoveryIssue) => void = () => {}) {}
	private folder(id: string): string { return path.join(this.directory, createHash('sha256').update(id).digest('hex')); }
	private parseManifest(body: string, file: string, expectedId?: string): Manifest {
		const value = JSON.parse(body) as Manifest;
		const summary = value?.summary;
		if (value?.version !== 1 || !summary || typeof summary.id !== 'string' || !summary.id || typeof summary.title !== 'string'
			|| (expectedId !== undefined && summary.id !== expectedId) || this.folder(summary.id) !== path.dirname(file)
			|| !Number.isFinite(summary.createdAt) || !Number.isFinite(summary.updatedAt) || !Number.isSafeInteger(summary.messageCount) || summary.messageCount < 0
			|| ['lastSpecialist', 'lastModel', 'workspaceId', 'workspaceName'].some(key => { const field = summary[key as keyof ConversationSummary]; return field !== undefined && typeof field !== 'string'; })
			|| ['pinned', 'archived'].some(key => { const field = summary[key as keyof ConversationSummary]; return field !== undefined && typeof field !== 'boolean'; })
			|| (summary.deletedAt !== undefined && !Number.isFinite(summary.deletedAt))
			|| (summary.lastMode !== undefined && !['act', 'plan'].includes(summary.lastMode))
			|| (summary.lastTab !== undefined && !['chat', 'tasks', 'history', 'settings', 'roster'].includes(summary.lastTab))
			|| (summary.branch !== undefined && (!summary.branch || typeof summary.branch.parentId !== 'string' || !Number.isSafeInteger(summary.branch.throughMessageIndex) || summary.branch.throughMessageIndex < 0 || !['checkpoint-available', 'unlinked'].includes(summary.branch.workspaceState) || (summary.branch.checkpointId !== undefined && typeof summary.branch.checkpointId !== 'string')))
			|| !Array.isArray(value.pages) || value.pages.length !== Math.ceil(summary.messageCount / PAGE_SIZE) || value.pages.some(page => typeof page !== 'string' || !/^[a-f0-9]{64}\.json$/.test(page))) { throw new Error('Invalid conversation manifest.'); }
		return value;
	}
	private manifest(file: string, expectedId?: string): Manifest | undefined {
		try {
			return this.parseManifest(fs.readFileSync(file, 'utf8'), file, expectedId);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
			this.onRecoveryIssue({ path: file, message: error instanceof Error ? error.message : String(error) });
			throw new Error('Conversation manifest failed its integrity check.', { cause: error });
		}
	}
	private async manifestAsync(file: string, expectedId?: string): Promise<Manifest | undefined> {
		try { return this.parseManifest(await fsp.readFile(file, 'utf8'), file, expectedId); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
			this.onRecoveryIssue({ path: file, message: error instanceof Error ? error.message : String(error) });
			throw new Error('Conversation manifest failed its integrity check.', { cause: error });
		}
	}
	async listAsync(signal?: AbortSignal): Promise<ConversationSummary[]> {
		let entries: fs.Dirent[];
		try { entries = await fsp.readdir(this.directory, { withFileTypes: true }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.onRecoveryIssue({ path: this.directory, message: error instanceof Error ? error.message : String(error) }); }
			return [];
		}
		const summaries: ConversationSummary[] = [];
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) { continue; }
			try { const manifest = await this.manifestAsync(path.join(this.directory, entry.name, 'manifest.json')); if (manifest) { summaries.push(manifest.summary); } }
			catch { /* A damaged manifest does not hide healthy history. */ }
		}
		return summaries;
	}

	/** Search immutable, text-only derived pages while retaining the selected message snapshot. */
	async matches(id: string, query: string, signal?: AbortSignal): Promise<boolean> {
		const folder = this.folder(id); const manifestFile = path.join(folder, 'manifest.json');
		for (let attempt = 0; attempt < 5; attempt++) {
			signal?.throwIfAborted();
			const manifest = await this.manifestAsync(manifestFile, id); if (!manifest) { return false; }
			let lease: string | undefined;
			try { lease = this.createLease(folder, 'reader', manifest.pages); }
			catch (error) { if (!['EROFS', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; } }
			try {
				const current = await this.manifestAsync(manifestFile, id);
				if (!current || JSON.stringify(current.pages) !== JSON.stringify(manifest.pages)) { continue; }
				let failedPage = folder;
				try {
					for (const page of manifest.pages) {
						signal?.throwIfAborted(); const file = path.join(folder, page); const index = `${file}.search`; failedPage = file;
						try { if (await searchIndexMatches(index, query, signal)) { return true; } }
						catch {
							signal?.throwIfAborted();
							// Derived caches may be rebuilt, but the authoritative page must pass integrity checks.
							const rebuilt = await buildLegacySearchIndex(file, index, query, signal);
							if (rebuilt.cacheError) { this.onRecoveryIssue({ path: index, message: `Conversation search cache could not be saved: ${rebuilt.cacheError}` }); }
							if (rebuilt.matched) { return true; }
						}
					}
					return false;
				} catch (error) {
					signal?.throwIfAborted();
					if (!lease) { const latest = await this.manifestAsync(manifestFile, id); if (!latest || JSON.stringify(latest.pages) !== JSON.stringify(manifest.pages)) { continue; } }
					this.onRecoveryIssue({ path: failedPage, message: error instanceof Error ? error.message : String(error) }); throw error;
				}
			} finally { if (lease) { await fsp.rm(lease, { force: true }); } }
		}
		throw new Error('Conversation changed repeatedly while searching. Please try again.');
	}

	list(): ConversationSummary[] {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(this.directory, { withFileTypes: true }); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.onRecoveryIssue({ path: this.directory, message: error instanceof Error ? error.message : String(error) }); }
			return [];
		}
		return entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).flatMap(entry => {
			const file = path.join(this.directory, entry.name, 'manifest.json');
			if (!fs.existsSync(file)) { return []; }
			try { const manifest = this.manifest(file); return manifest ? [manifest.summary] : []; }
			catch { return []; } // Preserve damaged files and continue exposing every healthy conversation.
		});
	}
	load(id: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): ConversationRecord | undefined {
		const folder = this.folder(id);
		for (let attempt = 0; attempt < 5; attempt++) {
			const manifest = this.manifest(path.join(folder, 'manifest.json'), id); if (!manifest) { return undefined; }
			let lease: string | undefined;
			try { lease = this.createLease(folder, 'reader', manifest.pages); }
			catch (error) { if (!['EROFS', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; } }
			try {
				// A collector may have taken its root snapshot before this lease appeared.
				// Recheck before opening pages; a changed manifest means retrying its new snapshot.
				const current = this.manifest(path.join(folder, 'manifest.json'), id);
				if (!current || JSON.stringify(current.pages) !== JSON.stringify(manifest.pages) || current.summary.messageCount !== manifest.summary.messageCount) { continue; }
				try { return this.readPages(id, manifest, offset, limit, lease !== undefined); }
				catch (error) {
					if (!lease) {
						// Read-only storage cannot publish a lease. If collection removes a page
						// during its read, retry the new manifest rather than returning partial history.
						const latest = this.manifest(path.join(folder, 'manifest.json'), id);
						if (!latest || JSON.stringify(latest.pages) !== JSON.stringify(manifest.pages) || latest.summary.messageCount !== manifest.summary.messageCount) { continue; }
						this.onRecoveryIssue({ path: folder, message: error instanceof Error ? error.message : String(error) });
					}
					throw error;
				}
			} finally { if (lease) { fs.rmSync(lease, { force: true }); } }
		}
		throw new Error('Conversation changed repeatedly while loading. Please try again.');
	}
	private readPages(id: string, manifest: Manifest, offset: number, limit: number, reportIssues = true): ConversationRecord {
		const start = Math.max(0, Math.floor(offset)); const end = Math.min(manifest.summary.messageCount, start + Math.max(0, Math.floor(limit)));
		const messages: ChatMessage[] = [];
		for (let page = Math.floor(start / PAGE_SIZE); page < Math.ceil(end / PAGE_SIZE); page++) {
			const file = path.join(this.folder(id), manifest.pages[page]);
			try {
				const body = fs.readFileSync(file, 'utf8');
				if (`${createHash('sha256').update(body).digest('hex')}.json` !== manifest.pages[page]) { throw new Error('Conversation message page failed its integrity check.'); }
				const values = JSON.parse(body) as ChatMessage[];
				if (!Array.isArray(values) || values.length !== Math.min(PAGE_SIZE, manifest.summary.messageCount - page * PAGE_SIZE)) { throw new Error('Invalid conversation message page.'); }
				messages.push(...values.slice(Math.max(0, start - page * PAGE_SIZE), Math.min(PAGE_SIZE, end - page * PAGE_SIZE)));
			} catch (error) { if (reportIssues) { this.onRecoveryIssue({ path: file, message: error instanceof Error ? error.message : String(error) }); } throw error; }
		}
		return { summary: manifest.summary, messages };
	}
	async save(record: ConversationRecord): Promise<void> {
		const folder = this.folder(record.summary.id); await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
		const bodies = new Map<string, { body: string; messages: ChatMessage[] }>(); const pages: string[] = [];
		for (let offset = 0; offset < record.messages.length; offset += PAGE_SIZE) {
			const messages = record.messages.slice(offset, offset + PAGE_SIZE); const body = JSON.stringify(messages);
			const name = `${createHash('sha256').update(body).digest('hex')}.json`; pages.push(name);
			bodies.set(name, { body, messages });
		}
		const lease = this.createLease(folder, 'writer', pages);
		try {
			// Publish prospective hashes before checking the collection barrier. A collector
			// either retains this lease or finishes before the writer checks/reuses any pages.
			await this.waitForCollectors(folder);
			for (const [name, { body, messages }] of bodies) {
				if (!fs.existsSync(path.join(folder, name))) { await this.atomicWrite(path.join(folder, name), body); }
				if (!fs.existsSync(path.join(folder, `${name}.search`))) {
					try { await writeSearchIndex(path.join(folder, `${name}.search`), messages); }
					catch (error) { this.onRecoveryIssue({ path: path.join(folder, `${name}.search`), message: `Conversation search cache could not be saved: ${error instanceof Error ? error.message : String(error)}` }); }
				}
			}
			await this.atomicWrite(path.join(folder, 'manifest.json'), JSON.stringify({ version: 1, summary: { ...record.summary, messageCount: record.messages.length }, pages } satisfies Manifest));
			this.collectPages(folder, record.summary.id);
		} finally {
			// Another collector may have read the previous manifest before this commit.
			// Retain the lease until every overlapping collector has finished its deletions.
			await this.waitForCollectors(folder);
			fs.rmSync(lease, { force: true });
		}
	}

	private createLease(folder: string, kind: 'reader' | 'writer', pages: readonly string[]): string {
		const lease = path.join(folder, `.${kind}-${hostProcess.pid}-${randomUUID()}`);
		const temporary = `${lease}.tmp`;
		try { fs.writeFileSync(temporary, JSON.stringify(pages), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, lease); }
		finally { fs.rmSync(temporary, { force: true }); }
		return lease;
	}

	private liveOwner(name: string): RegExpExecArray | undefined {
		const owner = OWNER_FILE.exec(name); if (!owner) { return undefined; }
		try { hostProcess.kill(Number(owner[2]), 0); return owner; }
		catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? undefined : owner; }
	}

	private async waitForCollectors(folder: string): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (fs.readdirSync(folder).some(name => this.liveOwner(name)?.[1] === 'gc')) {
			if (Date.now() >= deadline) { throw new Error('Conversation storage cleanup is busy. Please try saving again.'); }
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		}
	}

	private collectPages(folder: string, id: string): void {
		const marker = path.join(folder, `.gc-${hostProcess.pid}-${randomUUID()}`);
		let collecting = false;
		try {
			fs.closeSync(fs.openSync(marker, 'wx', 0o600)); collecting = true;
			const current = this.manifest(path.join(folder, 'manifest.json'), id); if (!current) { return; }
			const retained = new Set(current.pages);
			const entries = fs.readdirSync(folder);
			for (const name of entries) {
				const owner = this.liveOwner(name);
				if (owner && owner[1] !== 'gc') {
					let pages: string[];
					try { pages = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as string[]; }
					catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { continue; } throw error; }
					if (!Array.isArray(pages) || pages.some(page => typeof page !== 'string' || !PAGE_NAME.test(page))) { throw new Error('Invalid conversation page lease. Cleanup was skipped.'); }
					for (const page of pages) { retained.add(page); }
				}
			}
			for (const name of entries) {
				const indexedPage = name.endsWith('.search') ? name.slice(0, -7) : name;
				if ((PAGE_NAME.test(indexedPage) && !retained.has(indexedPage)) || (OWNER_FILE.test(name) && !this.liveOwner(name))) { fs.rmSync(path.join(folder, name), { force: true }); }
			}
		} catch (error) {
			// Cleanup is best effort after the manifest is durable; preserve data on uncertainty.
			this.onRecoveryIssue({ path: folder, message: error instanceof Error ? error.message : String(error) });
		} finally { if (collecting) { fs.rmSync(marker, { force: true }); } }
	}
	private async atomicWrite(destination: string, body: string): Promise<void> {
		const temporary = path.join(path.dirname(destination), `.write-${randomUUID()}.tmp`);
		try {
			const file = await fsp.open(temporary, 'wx', 0o600);
			try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
			await fsp.rename(temporary, destination);
		} finally { await fsp.rm(temporary, { force: true }); }
	}

	async delete(id: string): Promise<void> { await fsp.rm(this.folder(id), { recursive: true, force: true }); }
}
