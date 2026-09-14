// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

/** Provider contracts use the canonical shared agent-event definitions. */
import type { AgentEvent, ModelDescriptor, UniformRequest } from '../../_shared/agent-events/dist/index.js';
export type { AgentEvent, StopReason, MessageRole, MessageContent, UniformMessage, UniformTool, CacheBreakpoint, UniformRequest, ModelDescriptor } from '../../_shared/agent-events/dist/index.js';

/**
 * Receives token-usage data from a provider adapter on every `usage` event.
 * Implementations record to Prometheus, cost accumulators, or test spies.
 */
export interface UsageObserver {
	recordUsage(usage: {
		readonly provider: string;
		readonly model: string;
		readonly agentRole: string;
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cacheCreationInputTokens: number;
		readonly cacheReadInputTokens: number;
	}): void;
}

/**
 * Every provider adapter implements this interface (§5.7 of the plan).
 * `send()` is an async generator so backpressure flows naturally up through
 * the router, IDE, and chat UI.
 */
export interface ProviderAdapter {
	readonly id: string;
	readonly displayName: string;
	isAvailable(): Promise<boolean>;
	listModels(): Promise<ModelDescriptor[]>;
	send(req: UniformRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
}

/** Rate-limit headers Anthropic exposes; surfaced to the IDE for the quota chip. */
export interface RateLimitInfo {
	readonly requestsLimit?: number;
	readonly requestsRemaining?: number;
	readonly requestsReset?: string;
	readonly tokensLimit?: number;
	readonly tokensRemaining?: number;
	readonly tokensReset?: string;
}
