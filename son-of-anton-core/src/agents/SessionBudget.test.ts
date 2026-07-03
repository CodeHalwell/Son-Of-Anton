/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { SessionBudget, SpendCapExceededError } from './SessionBudget.js';

describe('SessionBudget', () => {
	test('rejects a budget with no caps configured', () => {
		assert.throws(() => new SessionBudget({}), /at least one of/);
	});

	test('rejects negative or non-finite caps', () => {
		assert.throws(() => new SessionBudget({ maxTotalTokens: -1 }));
		assert.throws(() => new SessionBudget({ maxCostUsd: Number.NaN }));
		assert.throws(() => new SessionBudget({ maxRequests: Number.POSITIVE_INFINITY }));
	});

	test('accumulates usage across calls into the snapshot', () => {
		const budget = new SessionBudget({ maxTotalTokens: 1_000_000 });
		budget.recordUsage({ inputTokens: 100, outputTokens: 20, cachedTokens: 5, costUsd: 0.01 });
		budget.recordUsage({ inputTokens: 50, outputTokens: 10, costUsd: 0.02 });
		assert.deepStrictEqual(budget.snapshot(), {
			inputTokens: 150,
			outputTokens: 30,
			cachedTokens: 5,
			totalTokens: 185,
			costUsd: 0.03,
			requestCount: 2,
		});
	});

	test('clamps negative usage fields so spend can never decrease', () => {
		const budget = new SessionBudget({ maxRequests: 10 });
		budget.recordUsage({ inputTokens: -100, outputTokens: -5, cachedTokens: -1, costUsd: -1 });
		const snap = budget.snapshot();
		assert.equal(snap.totalTokens, 0);
		assert.equal(snap.costUsd, 0);
		// The call itself still counts towards the request cap.
		assert.equal(snap.requestCount, 1);
	});

	test('token cap trips at or above the limit, not below', () => {
		const budget = new SessionBudget({ maxTotalTokens: 100 });
		budget.recordUsage({ inputTokens: 60, outputTokens: 30 }); // 90 total
		assert.equal(budget.isExceeded(), false);
		assert.equal(budget.describeExceeded(), undefined);
		budget.recordUsage({ inputTokens: 10 }); // 100 total — reaches cap
		assert.equal(budget.isExceeded(), true);
		assert.match(budget.describeExceeded() ?? '', /token cap reached \(100 \/ 100/);
	});

	test('cost cap trips independently of the token cap', () => {
		const budget = new SessionBudget({ maxCostUsd: 0.5 });
		budget.recordUsage({ inputTokens: 999999, costUsd: 0.25 });
		assert.equal(budget.isExceeded(), false);
		budget.recordUsage({ costUsd: 0.30 });
		assert.equal(budget.isExceeded(), true);
		assert.match(budget.describeExceeded() ?? '', /cost cap reached/);
	});

	test('request cap trips after the configured number of calls', () => {
		const budget = new SessionBudget({ maxRequests: 3 });
		budget.recordUsage({});
		budget.recordUsage({});
		assert.equal(budget.isExceeded(), false);
		budget.recordUsage({});
		assert.equal(budget.isExceeded(), true);
		assert.match(budget.describeExceeded() ?? '', /request cap reached \(3 \/ 3/);
	});

	test('assertWithinBudget throws SpendCapExceededError only once exceeded', () => {
		const budget = new SessionBudget({ maxRequests: 1 });
		// Within budget: no throw, before the first recorded call.
		assert.doesNotThrow(() => budget.assertWithinBudget());
		budget.recordUsage({ inputTokens: 10, outputTokens: 10 });
		let caught: unknown;
		try {
			budget.assertWithinBudget();
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof SpendCapExceededError);
		assert.match((caught as SpendCapExceededError).message, /request cap reached/);
		// The error carries the snapshot at the moment of the trip.
		assert.equal((caught as SpendCapExceededError).snapshot.requestCount, 1);
	});
});
