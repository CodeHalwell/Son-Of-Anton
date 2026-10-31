/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import type { WorkflowCatalogEntry } from '@codypendent/protocol';
import { parseWorkflowInputs, WORKFLOW_MAX_INPUT_BYTES, WORKFLOW_MAX_INPUT_FIELDS, WORKFLOW_MAX_TOTAL_INPUT_BYTES } from '../src/workflowInputs.js';

type Declarations = WorkflowCatalogEntry['inputs'];
const declaration = { input_type: 'domain-specific-input', required: true };

describe('workflow input boundary', () => {
	it('preserves JSON types for opaque domain inputs without inferring defaults or schemas', () => {
		const values = { text: '"quoted"', number: '42', zero: '0', flag: 'false', empty: 'null', list: '[1,"two",false]', object: '{"url":"https://example.test/pr/1"}', omitted: '   ' };
		const declarations = Object.fromEntries(Object.keys(values).map(name => [name, { input_type: 'github_pull_request', required: name !== 'omitted' }]));
		expect(parseWorkflowInputs(declarations, values)).toEqual({ ok: true, inputs: { text: 'quoted', number: 42, zero: 0, flag: false, empty: null, list: [1, 'two', false], object: { url: 'https://example.test/pr/1' } } });
	});

	it('rejects missing required values, undeclared fields and unavailable declarations', () => {
		expect(parseWorkflowInputs({ branch: declaration }, { branch: ' \n ' })).toEqual({ ok: false, field: 'branch', reason: 'required' });
		expect(parseWorkflowInputs({ branch: declaration }, { branch: '"main"', extra: 'true' })).toEqual({ ok: false, field: 'extra', reason: 'unknown-input' });
		expect(parseWorkflowInputs({ unavailable: undefined }, {})).toEqual({ ok: false, field: 'unavailable', reason: 'unknown-input' });
	});

	it('uses own fields and safely preserves JSON keys named __proto__ without prototype mutation', () => {
		const declarations = JSON.parse('{"__proto__":{"input_type":"object","required":true}}') as Declarations;
		const result = parseWorkflowInputs(declarations, JSON.parse('{"__proto__":"{\\"polluted\\":true}"}') as Record<string, string>);
		expect(result).toEqual({ ok: true, inputs: JSON.parse('{"__proto__":{"polluted":true}}') });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		const inherited = Object.create({ branch: '"main"' }) as Record<string, string>;
		expect(parseWorkflowInputs({ branch: declaration }, inherited)).toEqual({ ok: false, field: 'branch', reason: 'required' });
	});

	it('returns safe validation reasons without reflecting invalid input or parser details', () => {
		for (const raw of ['private-value-not-json', '1e400', '{"nested":1e400}', '['.repeat(65) + '0' + ']'.repeat(65)]) {
			expect(parseWorkflowInputs({ value: declaration }, { value: raw })).toEqual({ ok: false, field: 'value', reason: 'invalid-json' });
		}
	});

	it('bounds the declared and supplied field counts without silently omitting required fields', () => {
		const declarations = Object.fromEntries(Array.from({ length: WORKFLOW_MAX_INPUT_FIELDS + 1 }, (_, index) => [`field${index}`, declaration]));
		expect(parseWorkflowInputs(declarations, {})).toEqual({ ok: false, reason: 'too-many' });
		const values = Object.fromEntries(Object.keys(declarations).map(name => [name, 'true']));
		expect(parseWorkflowInputs({}, values)).toEqual({ ok: false, reason: 'too-many' });
	});

	it('counts UTF-8 bytes rather than UTF-16 characters at the individual value limit', () => {
		const atLimit = '"' + 'a'.repeat(WORKFLOW_MAX_INPUT_BYTES - 2) + '"';
		const accepted = parseWorkflowInputs({ value: declaration }, { value: atLimit });
		expect(accepted.ok).toBe(true);
		expect(parseWorkflowInputs({ value: declaration }, { value: atLimit + ' ' })).toEqual({ ok: false, field: 'value', reason: 'too-large' });
		const multibyte = '"' + 'é'.repeat(WORKFLOW_MAX_INPUT_BYTES / 2) + '"';
		expect(multibyte.length).toBeLessThan(WORKFLOW_MAX_INPUT_BYTES);
		expect(parseWorkflowInputs({ value: declaration }, { value: multibyte })).toEqual({ ok: false, field: 'value', reason: 'too-large' });
	});

	it('bounds aggregate raw JSON bytes before constructing the outbound input object', () => {
		const count = WORKFLOW_MAX_TOTAL_INPUT_BYTES / WORKFLOW_MAX_INPUT_BYTES;
		const value = '"' + 'a'.repeat(WORKFLOW_MAX_INPUT_BYTES - 2) + '"';
		const declarations = Object.fromEntries(Array.from({ length: count + 1 }, (_, index) => [`field${index}`, { ...declaration, required: false }]));
		const atLimit = Object.fromEntries(Array.from({ length: count }, (_, index) => [`field${index}`, value]));
		expect(parseWorkflowInputs(declarations, atLimit).ok).toBe(true);
		expect(parseWorkflowInputs(declarations, { ...atLimit, [`field${count}`]: '0' })).toEqual({ ok: false, field: `field${count}`, reason: 'too-large' });
	});
});
