// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import type { AgentEvent, ModelDescriptor, ProviderAdapter, UniformRequest } from '../providers/types.js';

/** One slot in a failover chain — an adapter to try and the model to request. */
export interface FailoverSlot {
	readonly adapter: ProviderAdapter;
	readonly model: string;
}

/** Returns true for events that represent content visible to the consumer. */
function isContentEvent(event: AgentEvent): boolean {
	return event.type === 'text_delta'
		|| event.type === 'tool_use_start'
		|| event.type === 'tool_use_delta'
		|| event.type === 'tool_use_stop'
		|| event.type === 'thinking_delta';
}

/**
 * FailoverChain wraps an ordered list of (adapter, model) pairs and
 * implements the ProviderAdapter contract (§10.1 of AGENTIC_PLATFORM_PLAN.md).
 *
 * On a retryable error from the current adapter the chain advances to the
 * next slot:
 *
 *   Pre-stream failover — error before any content event (text_delta,
 *   tool_use_start, thinking_delta): the caller sees nothing from the failed
 *   attempt. Pre-content events (message_start, usage, etc.) are buffered and
 *   discarded on retry so the fallback adapter starts cleanly.
 *
 *   After visible content, an error terminates the request. Replaying a tool
 *   request could execute the same action twice and cannot be made transparent.
 *
 * A non-retryable error from any adapter terminates the stream immediately —
 * the error event is passed through to the caller and no further adapters
 * are tried.
 *
 * Exhausting all adapters (every one failed with a retryable error or threw)
 * yields a single terminal `error` event followed by `message_stop`.
 *
 * Failover is triggered by:
 *   - `AgentEvent.error` with `retryable: true`
 *   - A thrown exception (connection reset, network error)
 */
export class FailoverChain implements ProviderAdapter {
	readonly id: string;
	readonly displayName: string;

	private readonly slots: readonly FailoverSlot[];

	constructor(
		slots: readonly FailoverSlot[],
		id: string = 'failover-chain',
		displayName: string = 'Failover Chain',
		private readonly retryError: (error: unknown) => boolean = () => true,
	) {
		if (slots.length === 0) {
			throw new Error('FailoverChain requires at least one slot');
		}
		this.slots = slots;
		this.id = id;
		this.displayName = displayName;
	}

	async isAvailable(): Promise<boolean> {
		for (const { adapter } of this.slots) {
			try {
				if (await adapter.isAvailable()) {
					return true;
				}
			} catch {
				// continue checking remaining adapters
			}
		}
		return false;
	}

	async listModels(): Promise<ModelDescriptor[]> {
		const seen = new Set<string>();
		const models: ModelDescriptor[] = [];
		for (const { adapter } of this.slots) {
			try {
				for (const m of await adapter.listModels()) {
					if (!seen.has(m.id)) {
						seen.add(m.id);
						models.push(m);
					}
				}
			} catch {
				// tolerate unavailable adapters in model listing
			}
		}
		return models;
	}

	async *send(req: UniformRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
		let lastError: Extract<AgentEvent, { type: 'error' }> = { type: 'error', code: 'all_providers_failed', message: 'All providers failed', retryable: false };
		for (const { adapter, model } of this.slots) {
			const buffered: AgentEvent[] = [];
			let contentSeen = false;
			try {
				signal.throwIfAborted();
				for await (const event of adapter.send({ ...req, model }, signal)) {
					signal.throwIfAborted();
					if (event.type === 'error') {
						lastError = { ...event, retryable: false };
						if (event.retryable && !contentSeen) { break; }
						for (const previous of buffered) { yield previous; }
						yield lastError;
						yield { type: 'message_stop', stopReason: 'error' };
						return;
					}
					if (!contentSeen && isContentEvent(event)) {
						contentSeen = true;
						for (const previous of buffered) { yield previous; }
						buffered.length = 0;
					}
					if (contentSeen) { yield event; } else { buffered.push(event); }
					if (event.type === 'message_stop') {
						for (const previous of buffered) { yield previous; }
						return;
					}
				}
				if (contentSeen) {
					lastError = { type: 'error', code: 'incomplete_stream', message: 'Provider stream ended before completion', retryable: false };
				}
			} catch (error) {
				lastError = { type: 'error', code: signal.aborted ? 'cancelled' : (error as NodeJS.ErrnoException)?.code ?? (this.retryError(error) ? 'connection_reset' : 'PROVIDER_ERROR'), message: signal.aborted ? 'Request cancelled' : error instanceof Error ? error.message : 'Provider connection failed', retryable: false };
				if (!this.retryError(error)) { break; }
			}
			if (contentSeen || signal.aborted) { break; }
		}
		yield lastError;
		yield { type: 'message_stop', stopReason: 'error' };
	}
}
