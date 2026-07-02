/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { RateLimiter } from './rateLimiter.js';

describe('RateLimiter', () => {
	test('rejects invalid configuration', () => {
		assert.throws(() => new RateLimiter(0, 1000));
		assert.throws(() => new RateLimiter(1, 0));
	});

	test('allows up to capacity then blocks', () => {
		let now = 1000;
		const rl = new RateLimiter(3, 1000, () => now);
		assert.equal(rl.tryAcquire('a'), true);
		assert.equal(rl.tryAcquire('a'), true);
		assert.equal(rl.tryAcquire('a'), true);
		assert.equal(rl.tryAcquire('a'), false);
	});

	test('refills continuously over time', () => {
		let now = 0;
		const rl = new RateLimiter(2, 1000, () => now); // 1 token per 500ms
		assert.equal(rl.tryAcquire(), true);
		assert.equal(rl.tryAcquire(), true);
		assert.equal(rl.tryAcquire(), false);
		now = 500;
		assert.equal(rl.tryAcquire(), true);
		assert.equal(rl.tryAcquire(), false);
	});

	test('msUntilNextToken reflects the refill rate', () => {
		let now = 0;
		const rl = new RateLimiter(2, 1000, () => now); // 1 token per 500ms
		rl.tryAcquire();
		rl.tryAcquire();
		assert.equal(rl.tryAcquire(), false);
		const wait = rl.msUntilNextToken();
		assert.ok(wait > 0 && wait <= 500, `expected 0 < wait <= 500, got ${wait}`);
	});

	test('buckets are isolated per key', () => {
		let now = 0;
		const rl = new RateLimiter(1, 1000, () => now);
		assert.equal(rl.tryAcquire('agent-a'), true);
		assert.equal(rl.tryAcquire('agent-a'), false);
		assert.equal(rl.tryAcquire('agent-b'), true);
	});

	test('acquire waits until a token frees up, then proceeds', async () => {
		let now = 0;
		const rl = new RateLimiter(1, 1000, () => now);
		assert.equal(rl.tryAcquire(), true); // drain the only token
		let slept = 0;
		const fakeSleep = async (ms: number): Promise<void> => { slept += ms; now += ms; };
		await rl.acquire('default', fakeSleep);
		assert.ok(slept >= 1, `expected to sleep waiting for a token, slept ${slept}`);
	});

	test('acquire rejects immediately when the signal is already aborted', async () => {
		let now = 0;
		const rl = new RateLimiter(1, 1000, () => now);
		assert.equal(rl.tryAcquire(), true); // drain the only token
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(
			() => rl.acquire('default', async () => { /* unused */ }, ac.signal),
			(err: Error) => err.name === 'AbortError',
		);
	});

	test('acquire rejects fast when the signal aborts while queued', async () => {
		let now = 0;
		const rl = new RateLimiter(1, 1000, () => now);
		assert.equal(rl.tryAcquire(), true); // drain the only token
		const ac = new AbortController();
		// A sleep that never resolves on its own, so only the abort can end the
		// wait — proves the queued request fails fast instead of waiting a refill.
		const neverSleep = (): Promise<void> => new Promise<void>(() => { /* pending forever */ });
		const acquiring = rl.acquire('default', neverSleep, ac.signal);
		ac.abort();
		await assert.rejects(acquiring, (err: Error) => err.name === 'AbortError');
	});
});
