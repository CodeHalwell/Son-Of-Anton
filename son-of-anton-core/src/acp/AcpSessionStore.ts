/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type { MementoStore } from '../host';
import { object } from './protocol';

export interface AcpSessionRecord {
	version: 1;
	conversationId: string;
	sessionId: string;
	state: 'running' | 'settled' | 'interrupted';
	transcript: string[];
	updatedAt: number;
}

/** Host-owned recovery records, separate from the adapter's opaque session storage. */
export class AcpSessionStore {
	private writes: Promise<void> = Promise.resolve();
	private readonly pendingRecords = new Map<string, AcpSessionRecord>();
	private fallbackEvicted = false;
	constructor(private readonly storage: MementoStore) { }

	/** A prolonged outage exhausted the bounded host context; stored records require conservative recovery. */
	get recoveryContextLimited(): boolean { return this.fallbackEvicted; }

	get(key: string): AcpSessionRecord | undefined {
		const pending = this.pendingRecords.get(key);
		const value = pending ?? this.storage.get<AcpSessionRecord>(this.storageKey(key));
		if (!object(value) || value.version !== 1 || typeof value.conversationId !== 'string' || typeof value.sessionId !== 'string'
			|| !['running', 'settled', 'interrupted'].includes(value.state) || !Array.isArray(value.transcript) || !value.transcript.every(turn => typeof turn === 'string')) { return undefined; }
		return { ...value, state: !pending && this.fallbackEvicted ? 'interrupted' : value.state, transcript: [...value.transcript] };
	}

	async save(key: string, record: AcpSessionRecord): Promise<void> {
		// Retain recent conversational context, not raw image payloads, tool inputs or provider credentials.
		const transcript = record.transcript.map(turn => turn.slice(-64 * 1024));
		while (transcript.length && Buffer.byteLength(transcript.join('\n')) > 256 * 1024) { transcript.shift(); }
		// Preserve current host context if optional persistence fails. An older
		// settled disk record must not replace evidence of a later interrupted turn.
		const snapshot = { ...record, transcript };
		await this.serialize(async () => {
			try {
				const index = this.storage.get<Record<string, string>>('sota.acp.session.index.v1') ?? {};
				const storageKey = this.storageKey(key);
				await this.storage.update('sota.acp.session.index.v1', { ...index, [storageKey]: snapshot.conversationId });
				await this.storage.update(storageKey, snapshot);
				this.pendingRecords.delete(key);
			} catch (error) {
				this.pendingRecords.delete(key);
				// Bound the complete encoded payload, including keys and opaque IDs;
				// skip oversized records rather than truncating identifiers needed to resume.
				if (Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(snapshot)) <= 512 * 1024) { this.pendingRecords.set(key, snapshot); }
				else { this.fallbackEvicted = true; }
				// Retain at most 32 failed records (16 MiB of encoded payload).
				if (this.pendingRecords.size > 32) {
					this.pendingRecords.delete(this.pendingRecords.keys().next().value!); this.fallbackEvicted = true;
				}
				throw error;
			}
		});
	}

	async forgetConversation(conversationId: string): Promise<void> {
		await this.serialize(async () => {
			const index = { ...(this.storage.get<Record<string, string>>('sota.acp.session.index.v1') ?? {}) };
			for (const [key, owner] of Object.entries(index)) {
				if (typeof owner === 'string' && (owner === conversationId || owner.endsWith(`:${conversationId}`))) { await this.storage.update(key, undefined); delete index[key]; }
			}
			await this.storage.update('sota.acp.session.index.v1', index);
			for (const [key, record] of this.pendingRecords) {
				if (record.conversationId === conversationId || record.conversationId.endsWith(`:${conversationId}`)) { this.pendingRecords.delete(key); }
			}
		});
	}

	private serialize(action: () => Promise<void>): Promise<void> {
		const result = this.writes.then(action); this.writes = result.catch(() => {}); return result;
	}

	private storageKey(key: string): string {
		return `sota.acp.session.v1.${createHash('sha256').update(key).digest('hex')}`;
	}
}
