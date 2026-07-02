/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Injectable sleep so the async {@link RateLimiter.acquire} loop is testable. */
export type SleepFn = (ms: number) => Promise<void>;

const defaultSleep: SleepFn = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A per-key token-bucket rate limiter.
 *
 * Enforces the "maximum requests per minute per agent" limit: each agent
 * handle is its own bucket that refills continuously at `capacity` tokens per
 * `refillIntervalMs`. The pure {@link tryAcquire} / {@link msUntilNextToken}
 * methods take an injectable clock so behaviour is deterministic under test;
 * {@link acquire} is the thin async wrapper the runtime calls.
 */
export class RateLimiter {
	private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

	constructor(
		private readonly capacity: number,
		private readonly refillIntervalMs: number,
		private readonly now: () => number = () => Date.now(),
	) {
		if (!Number.isFinite(capacity) || capacity <= 0) {
			throw new Error(`RateLimiter capacity must be positive, got ${capacity}`);
		}
		if (!Number.isFinite(refillIntervalMs) || refillIntervalMs <= 0) {
			throw new Error(`RateLimiter refillIntervalMs must be positive, got ${refillIntervalMs}`);
		}
	}

	private refill(key: string): { tokens: number; updatedAt: number } {
		const nowMs = this.now();
		const bucket = this.buckets.get(key);
		if (!bucket) {
			const fresh = { tokens: this.capacity, updatedAt: nowMs };
			this.buckets.set(key, fresh);
			return fresh;
		}
		const elapsed = Math.max(0, nowMs - bucket.updatedAt);
		const refillRatePerMs = this.capacity / this.refillIntervalMs;
		bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * refillRatePerMs);
		bucket.updatedAt = nowMs;
		return bucket;
	}

	/** Consume a token for `key` if one is available; returns whether it was. */
	tryAcquire(key = 'default'): boolean {
		const bucket = this.refill(key);
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			return true;
		}
		return false;
	}

	/** Milliseconds until the next whole token is available for `key` (0 if now). */
	msUntilNextToken(key = 'default'): number {
		const bucket = this.refill(key);
		if (bucket.tokens >= 1) {
			return 0;
		}
		const deficit = 1 - bucket.tokens;
		const refillRatePerMs = this.capacity / this.refillIntervalMs;
		return Math.ceil(deficit / refillRatePerMs);
	}

	/** Wait (if needed) until a token is free for `key`, then consume it. */
	async acquire(key = 'default', sleep: SleepFn = defaultSleep): Promise<void> {
		// Loop rather than sleep-once because concurrent acquirers on the same
		// key may consume the token we were waiting for.
		while (!this.tryAcquire(key)) {
			await sleep(Math.max(1, this.msUntilNextToken(key)));
		}
	}
}
