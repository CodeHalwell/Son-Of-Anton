// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.
// ── Type guards ──────────────────────────────────────────────────────────────
export function isMessageStart(event) {
    return event.type === 'message_start';
}
export function isTextDelta(event) {
    return event.type === 'text_delta';
}
export function isToolUseStart(event) {
    return event.type === 'tool_use_start';
}
export function isToolUseDelta(event) {
    return event.type === 'tool_use_delta';
}
export function isToolUseStop(event) {
    return event.type === 'tool_use_stop';
}
export function isThinkingDelta(event) {
    return event.type === 'thinking_delta';
}
export function isUsage(event) {
    return event.type === 'usage';
}
export function isMessageStop(event) {
    return event.type === 'message_stop';
}
export function isError(event) {
    return event.type === 'error';
}
/**
 * True when an event carries the final usage totals (i.e. fired alongside
 * or after the message_stop event). Lets consumers avoid double-counting
 * mid-stream usage events that some providers emit incrementally.
 */
export function isTerminal(event) {
    return event.type === 'message_stop' || event.type === 'error';
}
/**
 * Aggregates a stream of usage events into a single running total.
 * Caller seeds with `emptyUsage()` and folds each UsageEvent through this.
 */
export function emptyUsage() {
    return {
        type: 'usage',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
    };
}
export function addUsage(a, b) {
    return {
        type: 'usage',
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0),
        cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0),
    };
}
//# sourceMappingURL=index.js.map