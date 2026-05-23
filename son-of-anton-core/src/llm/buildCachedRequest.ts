/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LlmMessage, LlmRequestOptions, ModelId, SystemPromptPart } from './LlmClient.js';

/**
 * The four named prompt slots whose order and cache-breakpoint placement
 * maximises Anthropic prompt-cache hit rates (§8.1 of the platform plan).
 *
 * Slots are ordered from most-static to most-dynamic so that a change to
 * a later slot does not invalidate earlier cache prefixes:
 *
 *   1. systemPrompt  — fully static; the agent's core role/behaviour.
 *   2. projectMemory — static per session; CLAUDE.md + recorded project
 *                      decisions. Changes at most once per workspace open.
 *   3. graphContext  — semi-static; code graph nodes relevant to the current
 *                      task. Changes when the user switches files/tasks.
 *   4. conversation  — fully dynamic; the user turn + assistant history.
 *                      No cache breakpoint — always re-sent.
 *
 * Each non-empty slot (1–3) emits one `cache_control: ephemeral` breakpoint,
 * staying within Anthropic's four-breakpoint limit.
 */
export interface CachedRequestSlots {
	/** Core agent role and behaviour instructions. Fully static across all turns. */
	readonly systemPrompt: string;
	/** CLAUDE.md content and recorded project decisions. Static per session. */
	readonly projectMemory?: string;
	/** Code graph context for the current task. Semi-static per task. */
	readonly graphContext?: string;
}

/**
 * Assembles an `LlmRequestOptions` with the prompt-cache breakpoints placed
 * in the correct order (system-prompt → project-memory → graph-context →
 * conversation). Callers should pass this directly to `LlmClient.stream()`.
 *
 * Only non-empty slots receive a `cache: 'ephemeral'` breakpoint, so a caller
 * that omits `projectMemory` and `graphContext` gets a single-breakpoint
 * request rather than wasting quota slots on empty blocks.
 *
 * @param model       The `ModelId` to target.
 * @param slots       Static and semi-static prompt content.
 * @param conversation The full message history (user + assistant turns).
 * @param overrides   Any other `LlmRequestOptions` fields (maxTokens, tools,
 *                    signal, agentHandle, …). `model`, `systemPromptParts`,
 *                    and `messages` are always overridden by this function.
 */
export function buildCachedRequest(
	model: ModelId,
	slots: CachedRequestSlots,
	conversation: readonly LlmMessage[],
	overrides?: Omit<LlmRequestOptions, 'model' | 'systemPromptParts' | 'messages'>,
): LlmRequestOptions {
	const parts: SystemPromptPart[] = [];

	if (slots.systemPrompt) {
		parts.push({ text: slots.systemPrompt, cache: 'ephemeral' });
	}
	if (slots.projectMemory) {
		parts.push({ text: slots.projectMemory, cache: 'ephemeral' });
	}
	if (slots.graphContext) {
		parts.push({ text: slots.graphContext, cache: 'ephemeral' });
	}

	return {
		...overrides,
		model,
		systemPromptParts: parts,
		messages: [...conversation],
	};
}
