/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A fair, FIFO counting semaphore for bounding concurrency.
 *
 * Used to enforce the "maximum concurrent API requests" limit across the agent
 * runtime: every provider call acquires a permit for the duration of its
 * request and releases it when the stream ends, so no more than `maxPermits`
 * requests are ever in flight at once — regardless of how widely the
 * orchestrator fans out.
 */
export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly maxPermits: number) {
		if (!Number.isInteger(maxPermits) || maxPermits < 1) {
			throw new Error(`Semaphore requires a positive integer permit count, got ${maxPermits}`);
		}
		this.available = maxPermits;
	}

	/**
	 * Acquire a permit, waiting (FIFO) until one is free. Pair every successful
	 * acquire with exactly one {@link release}, ideally via {@link runExclusive}.
	 *
	 * When a `signal` is supplied the wait is interruptible: an abort while
	 * queued removes this waiter and rejects (with the signal reason / an
	 * `AbortError`) instead of leaving the caller hung until an unrelated stream
	 * releases a permit. A rejected waiter never consumes a permit.
	 */
	acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) {
			return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
		}
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const waiter = (): void => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			};
			const onAbort = (): void => {
				const index = this.waiters.indexOf(waiter);
				if (index !== -1) {
					this.waiters.splice(index, 1);
				}
				reject(signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	/**
	 * Release a permit. If a waiter is queued the permit is handed directly to
	 * it (preserving the concurrency bound); otherwise the free count grows,
	 * capped at the configured maximum so stray releases can't inflate it.
	 */
	release(): void {
		const next = this.waiters.shift();
		if (next) {
			next();
			return;
		}
		this.available = Math.min(this.available + 1, this.maxPermits);
	}

	/** Run `fn` while holding a permit, releasing it even if `fn` throws. */
	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	/** Permits currently free (for diagnostics/tests). */
	get availablePermits(): number {
		return this.available;
	}

	/** Number of callers currently waiting for a permit (for diagnostics/tests). */
	get waiterCount(): number {
		return this.waiters.length;
	}
}
