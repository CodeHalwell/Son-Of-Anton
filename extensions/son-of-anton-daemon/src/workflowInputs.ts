/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { WorkflowCatalogEntry } from '@codypendent/protocol';

export const WORKFLOW_MAX_INPUT_FIELDS = 64;
export const WORKFLOW_MAX_INPUT_BYTES = 64 * 1024;
export const WORKFLOW_MAX_TOTAL_INPUT_BYTES = 256 * 1024;

export type WorkflowInputResult = { ok: true; inputs: Record<string, unknown> }
	| { ok: false; field?: string; reason: 'required' | 'invalid-json' | 'unsafe-integer' | 'unknown-input' | 'too-large' | 'too-many' };

/** Domain input types are opaque; preserve JSON values without guessing a schema or exposing parse contents. */
export function parseWorkflowInputs(declarations: WorkflowCatalogEntry['inputs'], rawValues: Record<string, string>): WorkflowInputResult {
	const declared = Object.entries(declarations);
	const supplied = Object.entries(rawValues);
	if (declared.length > WORKFLOW_MAX_INPUT_FIELDS || supplied.length > WORKFLOW_MAX_INPUT_FIELDS) { return { ok: false, reason: 'too-many' }; }
	const names = new Set(declared.map(([name]) => name));
	let totalBytes = 0;
	for (const [name, raw] of supplied) {
		if (!names.has(name)) { return { ok: false, field: name, reason: 'unknown-input' }; }
		if (typeof raw !== 'string') { return { ok: false, field: name, reason: 'invalid-json' }; }
		const bytes = Buffer.byteLength(raw, 'utf8');
		totalBytes += bytes;
		if (bytes > WORKFLOW_MAX_INPUT_BYTES || totalBytes > WORKFLOW_MAX_TOTAL_INPUT_BYTES) { return { ok: false, field: name, reason: 'too-large' }; }
	}
	const entries: Array<[string, unknown]> = [];
	for (const [name, declaration] of declared) {
		if (!declaration) { return { ok: false, field: name, reason: 'unknown-input' }; }
		const raw = Object.hasOwn(rawValues, name) ? rawValues[name].trim() : '';
		if (!raw) {
			if (declaration.required) { return { ok: false, field: name, reason: 'required' }; }
			continue;
		}
		let value: unknown;
		try { value = JSON.parse(raw); }
		catch { return { ok: false, field: name, reason: 'invalid-json' }; }
		const remaining: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
		while (remaining.length) {
			const item = remaining.pop()!;
			if (item.depth > 64 || typeof item.value === 'number' && !Number.isFinite(item.value)) { return { ok: false, field: name, reason: 'invalid-json' }; }
			if (typeof item.value === 'number' && Number.isInteger(item.value) && !Number.isSafeInteger(item.value)) {
				return { ok: false, field: name, reason: 'unsafe-integer' };
			}
			if (item.value && typeof item.value === 'object') {
				for (const nested of Object.values(item.value)) { remaining.push({ value: nested, depth: item.depth + 1 }); }
			}
		}
		entries.push([name, value]);
	}
	return { ok: true, inputs: Object.fromEntries(entries) };
}
