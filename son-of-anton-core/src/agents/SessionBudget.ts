/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Core-level session spend kill switch. Satisfies the CLAUDE.md requirement for
 * a "configurable spend cap per session (kill switch)" at the runtime layer so
 * the CLI and the orchestrator can be halted — previously this lived only in
 * the IDE extension's `SpendGuard`, which the headless surfaces never see.
 *
 * The {@link ISpendGuard} interface is intentionally tiny so a host can supply
 * its own implementation (e.g. one backed by a persisted cross-session ledger)
 * in place of the bundled {@link SessionBudget}. The guard is injected into the
 * agent stack as an *optional* dependency: when none is provided the runtime
 * behaves exactly as before (no cap).
 */

/**
 * One LLM call's usage, folded into a guard via {@link ISpendGuard.recordUsage}.
 * Every field is optional so a caller can record a bare `{ costUsd }` (a
 * provider that only reports dollar cost) or a bare
 * `{ inputTokens, outputTokens }` (the common case) without building a full
 * usage object.
 */
export interface SpendSample {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	/** Cache-read tokens. Counted towards the token cap alongside input tokens. */
	readonly cachedTokens?: number;
	/** Estimated dollar cost of the call, when the caller can compute one. */
	readonly costUsd?: number;
}

/** Point-in-time view of a session's accumulated spend. */
export interface SpendSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cachedTokens: number;
	/** `inputTokens + outputTokens + cachedTokens` — compared against `maxTotalTokens`. */
	readonly totalTokens: number;
	readonly costUsd: number;
	readonly requestCount: number;
}

/**
 * Session-level caps. Any subset may be set; an unset cap is never enforced.
 * A cap trips when the accumulated value reaches OR exceeds the limit — the
 * guard blocks the *next* call rather than letting a session spill over it.
 */
export interface SessionBudgetLimits {
	/** Hard cap on total tokens (input + output + cache reads) for the session. */
	readonly maxTotalTokens?: number;
	/** Hard cap on estimated cost in USD for the session. */
	readonly maxCostUsd?: number;
	/** Hard cap on the number of LLM requests for the session. */
	readonly maxRequests?: number;
}

/**
 * Thrown by {@link ISpendGuard.assertWithinBudget} when a session's accumulated
 * spend has crossed a configured cap. Carries the human-readable reason and the
 * snapshot at the moment of the trip so surfaces can render a precise
 * "you spent X of Y" message.
 */
export class SpendCapExceededError extends Error {
	readonly snapshot: SpendSnapshot;
	constructor(reason: string, snapshot: SpendSnapshot) {
		super(reason);
		this.name = 'SpendCapExceededError';
		this.snapshot = snapshot;
	}
}

/**
 * Minimal contract consulted by `BaseAgent` (before each LLM call) and the
 * `OrchestratorAgent` (before dispatching each subtask). Kept narrow so hosts
 * can substitute their own accounting without depending on {@link SessionBudget}.
 */
export interface ISpendGuard {
	/** Fold one LLM call's usage into the running totals. */
	recordUsage(sample: SpendSample): void;
	/** True once any configured cap has been reached. Never throws. */
	isExceeded(): boolean;
	/** Throw {@link SpendCapExceededError} when {@link isExceeded} would return true. */
	assertWithinBudget(): void;
	/**
	 * Human-readable description of the crossed cap, or `undefined` when still
	 * within budget. Used both for the thrown error message and for the
	 * orchestrator's halt banner.
	 */
	describeExceeded(): string | undefined;
	/** Current accumulated totals. */
	snapshot(): SpendSnapshot;
}

/**
 * Default {@link ISpendGuard} implementation: an in-memory accumulator with
 * configurable token / cost / request caps. Thread-safe enough for the
 * orchestrator's concurrent fan-out because every mutation is a synchronous
 * scalar add (Node runs it on a single thread).
 */
export class SessionBudget implements ISpendGuard {
	private inputTokens = 0;
	private outputTokens = 0;
	private cachedTokens = 0;
	private costUsd = 0;
	private requestCount = 0;
	private readonly limits: SessionBudgetLimits;

	constructor(limits: SessionBudgetLimits) {
		// Reject a budget that can never trip. An all-undefined limits object is
		// a common misconfiguration that would silently disable the kill switch;
		// callers that genuinely want "no cap" should simply not inject a guard.
		if (limits.maxTotalTokens === undefined && limits.maxCostUsd === undefined && limits.maxRequests === undefined) {
			throw new Error('SessionBudget requires at least one of maxTotalTokens, maxCostUsd, or maxRequests.');
		}
		for (const [key, value] of Object.entries(limits)) {
			if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
				throw new Error(`SessionBudget limit "${key}" must be a non-negative finite number, got ${String(value)}.`);
			}
		}
		this.limits = limits;
	}

	recordUsage(sample: SpendSample): void {
		// Clamp each field at 0 so a stray negative (e.g. a provider quirk) can
		// never *reduce* accumulated spend and defeat the kill switch.
		this.inputTokens += Math.max(0, sample.inputTokens ?? 0);
		this.outputTokens += Math.max(0, sample.outputTokens ?? 0);
		this.cachedTokens += Math.max(0, sample.cachedTokens ?? 0);
		this.costUsd += Math.max(0, sample.costUsd ?? 0);
		this.requestCount += 1;
	}

	snapshot(): SpendSnapshot {
		return {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cachedTokens: this.cachedTokens,
			totalTokens: this.inputTokens + this.outputTokens + this.cachedTokens,
			costUsd: this.costUsd,
			requestCount: this.requestCount,
		};
	}

	isExceeded(): boolean {
		return this.describeExceeded() !== undefined;
	}

	describeExceeded(): string | undefined {
		const snap = this.snapshot();
		if (this.limits.maxTotalTokens !== undefined && snap.totalTokens >= this.limits.maxTotalTokens) {
			return `Session token cap reached (${snap.totalTokens} / ${this.limits.maxTotalTokens} tokens).`;
		}
		if (this.limits.maxCostUsd !== undefined && snap.costUsd >= this.limits.maxCostUsd) {
			return `Session cost cap reached ($${snap.costUsd.toFixed(4)} / $${this.limits.maxCostUsd.toFixed(2)}).`;
		}
		if (this.limits.maxRequests !== undefined && snap.requestCount >= this.limits.maxRequests) {
			return `Session request cap reached (${snap.requestCount} / ${this.limits.maxRequests} requests).`;
		}
		return undefined;
	}

	assertWithinBudget(): void {
		const reason = this.describeExceeded();
		if (reason !== undefined) {
			throw new SpendCapExceededError(reason, this.snapshot());
		}
	}
}
