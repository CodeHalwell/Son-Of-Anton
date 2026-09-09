/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface TimelineRange { start: number; end: number; total: number; older: number; newer: number; indices: number[] }

/** Plain message data survives eviction; only the returned window and pinned live turn are mounted. */
export class TimelineWindow<T> {
	private records: Array<T | undefined> = [];
	private start = 0;
	private end = 0;

	constructor(readonly capacity = 300, readonly pageSize = 100, readonly initialSize = 200) {
		if (!Number.isInteger(capacity) || capacity < 2 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > capacity || !Number.isInteger(initialSize) || initialSize < 1 || initialSize > capacity) { throw new Error('Invalid timeline window limits'); }
	}

	get length(): number { return this.records.length; }
	get(index: number): T | undefined { return this.records[index]; }

	reset(records: readonly T[] = []): void {
		this.records = [...records]; this.end = records.length; this.start = Math.max(0, this.end - this.initialSize);
	}

	/** Reserve a visual timeline slot for an in-flight assistant; this is not a persisted message index. */
	observe(index: number): void {
		if (!Number.isSafeInteger(index) || index < 0 || index > this.records.length + 1) { return; }
		if (index >= this.records.length) { this.records.length = index + 1; }
	}

	set(index: number, record: T): void {
		this.observe(index);
		if (Number.isSafeInteger(index) && index >= 0 && index < this.records.length) { this.records[index] = record; }
	}

	older(): void {
		this.start = Math.max(0, this.start - this.pageSize);
		this.end = Math.min(this.records.length, this.start + this.capacity);
	}

	newer(): void {
		this.end = Math.min(this.records.length, this.end + this.pageSize);
		this.start = Math.max(0, this.end - this.capacity);
	}

	latest(): void { this.end = this.records.length; this.start = Math.max(0, this.end - this.capacity); }

	/** Pinned live indices consume window slots, keeping the total mounted messages strictly bounded. */
	view(pinned: readonly number[] = []): TimelineRange {
		const pins = [...new Set(pinned)].filter(index => Number.isSafeInteger(index) && index >= 0 && index < this.records.length).sort((a, b) => a - b).slice(-this.capacity);
		const outside = pins.filter(index => index < this.start || index >= this.end);
		const start = this.start, end = Math.max(start, Math.min(this.end, start + this.capacity - outside.length));
		const indices = [...new Set([...Array.from({ length: end - start }, (_, offset) => start + offset), ...pins])].sort((a, b) => a - b);
		// A pin in the trimmed tail can add one extra entry. Prefer its identity over an ordinary row.
		while (indices.length > this.capacity) {
			let removable = indices.length - 1;
			while (removable >= 0 && pins.includes(indices[removable])) { removable--; }
			if (removable < 0) { break; } indices.splice(removable, 1);
		}
		return { start, end, total: this.records.length, older: start, newer: this.records.length - end, indices };
	}
}
