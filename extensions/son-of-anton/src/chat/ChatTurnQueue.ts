/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { randomUUID } from 'node:crypto';

/** Queued drafts belong to one conversation; stopping a turn pauses automatic dispatch. */
export class ChatTurnQueue<T> {
	private readonly conversations = new Map<string, { paused: boolean; entries: Array<{ id: string; draft: T }> }>();

	add(conversationId: string, draft: T, first = false): string {
		const state = this.state(conversationId);
		if (state.entries.length >= 10) { throw new Error('The follow-up queue is full (10 messages).'); }
		const entry = { id: randomUUID(), draft: structuredClone(draft) };
		if (first) { state.entries.unshift(entry); } else { state.entries.push(entry); }
		return entry.id;
	}

	/** Restore an already accepted draft after a pre-dispatch failure, even if its freed waiting slot was filled. */
	requeue(conversationId: string, draft: T, first = true): string {
		const state = this.state(conversationId); const entry = { id: randomUUID(), draft: structuredClone(draft) };
		if (first) { state.entries.unshift(entry); } else { state.entries.push(entry); }
		return entry.id;
	}

	snapshot(conversationId: string): { paused: boolean; entries: Array<{ id: string; draft: T }> } {
		return structuredClone(this.state(conversationId));
	}

	remove(conversationId: string, id: string): T | undefined {
		const entries = this.state(conversationId).entries;
		const index = entries.findIndex(entry => entry.id === id);
		return index < 0 ? undefined : entries.splice(index, 1)[0].draft;
	}

	move(conversationId: string, id: string, direction: -1 | 1): void {
		const entries = this.state(conversationId).entries;
		const index = entries.findIndex(entry => entry.id === id);
		const target = index + direction;
		if (index < 0 || target < 0 || target >= entries.length) { return; }
		[entries[index], entries[target]] = [entries[target], entries[index]];
	}

	pause(conversationId: string, paused = true): void { this.state(conversationId).paused = paused; }
	delete(conversationId: string): void { this.conversations.delete(conversationId); }
	clear(): void { this.conversations.clear(); }

	take(conversationId: string): T | undefined {
		const state = this.state(conversationId);
		return state.paused ? undefined : state.entries.shift()?.draft;
	}

	private state(conversationId: string): { paused: boolean; entries: Array<{ id: string; draft: T }> } {
		let state = this.conversations.get(conversationId);
		if (!state) { state = { paused: false, entries: [] }; this.conversations.set(conversationId, state); }
		return state;
	}
}
