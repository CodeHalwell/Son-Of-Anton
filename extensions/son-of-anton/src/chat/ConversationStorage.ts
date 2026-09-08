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

interface Manifest { version: 1; summary: ConversationSummary; pages: string[] }
const PAGE_SIZE = 100;
export interface ConversationRecoveryIssue { readonly path: string; readonly message: string }

/** Immutable message pages with an atomically replaced manifest; no shared index can lose another window's conversation. */
export class ConversationStorage {
	constructor(private readonly directory: string, private readonly onRecoveryIssue: (issue: ConversationRecoveryIssue) => void = () => {}) {}
	private folder(id: string): string { return path.join(this.directory, createHash('sha256').update(id).digest('hex')); }
	private manifest(file: string, expectedId?: string): Manifest | undefined {
		try {
			const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
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
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
			this.onRecoveryIssue({ path: file, message: error instanceof Error ? error.message : String(error) });
			throw new Error('Conversation manifest failed its integrity check.', { cause: error });
		}
	}
	list(): ConversationSummary[] {
		if (!fs.existsSync(this.directory)) { return []; }
		return fs.readdirSync(this.directory, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).flatMap(entry => {
			const file = path.join(this.directory, entry.name, 'manifest.json');
			if (!fs.existsSync(file)) { return []; }
			try { const manifest = this.manifest(file); return manifest ? [manifest.summary] : []; }
			catch { return []; } // Preserve damaged files and continue exposing every healthy conversation.
		});
	}
	load(id: string, offset = 0, limit = Number.MAX_SAFE_INTEGER): ConversationRecord | undefined {
		const manifest = this.manifest(path.join(this.folder(id), 'manifest.json'), id); if (!manifest) { return undefined; }
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
			} catch (error) { this.onRecoveryIssue({ path: file, message: error instanceof Error ? error.message : String(error) }); throw error; }
		}
		return { summary: manifest.summary, messages };
	}
	async save(record: ConversationRecord): Promise<void> {
		const folder = this.folder(record.summary.id); await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
		const pages: string[] = [];
		for (let offset = 0; offset < record.messages.length; offset += PAGE_SIZE) {
			const body = JSON.stringify(record.messages.slice(offset, offset + PAGE_SIZE));
			const name = `${createHash('sha256').update(body).digest('hex')}.json`; pages.push(name);
			if (!fs.existsSync(path.join(folder, name))) { await this.atomicWrite(path.join(folder, name), body); }
		}
		await this.atomicWrite(path.join(folder, 'manifest.json'), JSON.stringify({ version: 1, summary: record.summary, pages } satisfies Manifest));
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
