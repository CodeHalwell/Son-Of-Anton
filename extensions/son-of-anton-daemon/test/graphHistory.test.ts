/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import { GraphHistory } from '../src/graphHistory.js';

describe('graph browsing history', () => {
	it('returns to the exact filter, selected symbol, focus and scroll position', () => {
		const history = new GraphHistory({ path: 'src/', name: 'handle' });
		history.visit({ path: 'src/', name: 'handle', nodeId: 'handler' }, { scrollY: 480, focus: 'select:handler' }, { scrollY: 0, focus: 'selection' });
		history.visit({ path: 'src/', name: 'handle', nodeId: 'caller' }, { scrollY: 850, focus: 'select:caller' }, { scrollY: 0, focus: 'selection' });
		history.back();
		expect(history.current).toEqual({ selection: { path: 'src/', name: 'handle', nodeId: 'handler' }, position: { scrollY: 850, focus: 'select:caller' } });
		history.back();
		expect(history.current).toEqual({ selection: { path: 'src/', name: 'handle' }, position: { scrollY: 480, focus: 'select:handler' } });
		expect(history.previous).toBeUndefined();
	});

	it('refreshes and repeated queries do not add duplicate Back entries', () => {
		const history = new GraphHistory({ path: 'src/' });
		history.visit({ path: 'src/' }, { scrollY: 90 }, { scrollY: 90, focus: 'refresh' });
		expect(history.current.position).toEqual({ scrollY: 90, focus: 'refresh' });
		expect(history.previous).toBeUndefined();
		history.visit({}, { scrollY: 90, focus: 'reset' }, { scrollY: 0, focus: 'query-path' });
		history.back();
		expect(history.current).toEqual({ selection: { path: 'src/' }, position: { scrollY: 90, focus: 'reset' } });
	});

	it('retains only the bounded most recent views and protects stored snapshots', () => {
		const initial = { name: 'first' };
		const history = new GraphHistory(initial, 3);
		initial.name = 'mutated';
		for (const name of ['second', 'third', 'fourth']) { history.visit({ name }, { scrollY: 0 }, { scrollY: 0 }); }
		history.current.selection.name = 'mutated';
		history.previous!.position.scrollY = 999;
		expect(history.current.selection.name).toBe('fourth');
		history.back(); history.back(); history.back();
		expect(history.current).toEqual({ selection: { name: 'second' }, position: { scrollY: 0 } });
		expect(history.previous).toBeUndefined();
	});
});
