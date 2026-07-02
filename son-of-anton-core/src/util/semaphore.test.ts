/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
	test('rejects a non-positive or non-integer permit count', () => {
		assert.throws(() => new Semaphore(0));
		assert.throws(() => new Semaphore(-1));
		assert.throws(() => new Semaphore(1.5));
	});

	test('never exceeds the permit bound under concurrent load', async () => {
		const sem = new Semaphore(2);
		let active = 0;
		let peak = 0;
		const task = () => sem.runExclusive(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise(resolve => setTimeout(resolve, 5));
			active--;
		});
		await Promise.all(Array.from({ length: 6 }, task));
		assert.equal(peak, 2);
		assert.equal(active, 0);
		assert.equal(sem.availablePermits, 2);
	});

	test('hands permits to waiters in FIFO order', async () => {
		const sem = new Semaphore(1);
		const order: number[] = [];
		await sem.acquire();
		const w1 = sem.acquire().then(() => { order.push(1); });
		const w2 = sem.acquire().then(() => { order.push(2); });
		sem.release();
		await w1;
		sem.release();
		await w2;
		assert.deepStrictEqual(order, [1, 2]);
	});

	test('runExclusive releases the permit even when the task throws', async () => {
		const sem = new Semaphore(1);
		await assert.rejects(sem.runExclusive(async () => { throw new Error('boom'); }));
		assert.equal(sem.availablePermits, 1);
	});

	test('release does not inflate permits beyond the maximum', () => {
		const sem = new Semaphore(1);
		sem.release();
		sem.release();
		assert.equal(sem.availablePermits, 1);
	});
});
