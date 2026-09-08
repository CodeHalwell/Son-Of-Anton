/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { TimelineWindow } from '../src/chat/webview/TimelineWindow';

suite('Bounded conversation timeline', () => {
	test('repeated older and newer paging keeps at most 300 mounted indices without losing message data', () => {
		const timeline = new TimelineWindow<number>(); timeline.reset(Array.from({ length: 2000 }, (_, index) => index));
		assert.deepEqual([timeline.view().start, timeline.view().end], [1800, 2000]);
		for (let page = 0; page < 30; page++) { timeline.older(); assert.ok(timeline.view().indices.length <= 300); }
		assert.deepEqual([timeline.view().start, timeline.view().end, timeline.get(1999)], [0, 300, 1999]);
		for (let page = 0; page < 30; page++) { timeline.newer(); assert.ok(timeline.view().indices.length <= 300); }
		assert.deepEqual([timeline.view().start, timeline.view().end], [1700, 2000]);
	});
	test('live user and assistant slots stay mounted outside an older window without increasing the DOM cap', () => {
		const timeline = new TimelineWindow<string>(); timeline.reset(Array.from({ length: 1000 }, (_, index) => `Message ${index}`));
		for (let page = 0; page < 9; page++) { timeline.older(); }
		timeline.set(1000, 'New user'); timeline.observe(1001);
		const view = timeline.view([1000, 1001]);
		assert.deepEqual([view.indices.length, view.indices[0], view.indices.slice(-2)], [300, 0, [1000, 1001]]);
		timeline.set(1001, '**Completed** response'); timeline.latest();
		assert.deepEqual([timeline.view().indices.length, timeline.get(1001)], [300, '**Completed** response']);
	});
	test('conversation reset drops older source records and does not reuse their indices', () => {
		const timeline = new TimelineWindow<string>(); timeline.reset(['A', 'B']); timeline.reset(); timeline.set(0, 'New user'); timeline.latest();
		assert.deepEqual([timeline.length, timeline.get(1), timeline.view().indices], [1, undefined, [0]]);
	});
});
