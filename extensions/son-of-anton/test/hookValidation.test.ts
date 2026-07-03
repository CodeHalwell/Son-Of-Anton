/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Son of Anton Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { HookConfig, HooksFileConfig, validateHooks } from '../src/hooks/hookValidation';

suite('hookValidation', () => {
	const REGISTERED = ['anton', 'anton-code', 'anton-security'];

	function hook(overrides: Partial<HookConfig>): HookConfig {
		return {
			name: 'test-hook',
			trigger: 'onFileSave',
			agent: 'anton-code',
			instruction: 'Do the thing',
			blocking: false,
			...overrides,
		};
	}

	test('accepts hooks whose agent is registered', () => {
		const result = validateHooks([hook({}), hook({ name: 'security', agent: 'anton-security', trigger: 'preCommit' })], REGISTERED);
		assert.deepStrictEqual(
			{ valid: result.valid.map(h => h.name), invalid: result.invalid },
			{ valid: ['test-hook', 'security'], invalid: [] }
		);
	});

	test('rejects a hook naming an unregistered agent with a reason (F-20)', () => {
		const pentest = hook({ name: 'pentest-baseline-on-pr', agent: 'anton-pentest', trigger: 'onPRCreate' });
		const result = validateHooks([hook({}), pentest], REGISTERED);

		assert.deepStrictEqual(
			{
				valid: result.valid.map(h => h.name),
				invalidNames: result.invalid.map(i => i.hook.name),
				reasonMentionsAgent: result.invalid[0].reason.includes("'anton-pentest'"),
			},
			{ valid: ['test-hook'], invalidNames: ['pentest-baseline-on-pr'], reasonMentionsAgent: true }
		);
	});

	test('rejects structurally broken hooks', () => {
		const result = validateHooks([
			hook({ name: '' }),
			hook({ trigger: 'onCoffeeBreak' as never }),
			hook({ agent: '' }),
			hook({ instruction: '' }),
		], REGISTERED);

		assert.deepStrictEqual(
			{ validCount: result.valid.length, reasons: result.invalid.map(i => i.reason.split(' (')[0]) },
			{
				validCount: 0,
				reasons: [
					'hook has no name',
					"unknown trigger 'onCoffeeBreak'",
					'hook has no agent',
					'hook has no instruction',
				],
			}
		);
	});

	test('non-object entries are rejected instead of crashing validation', () => {
		const malformed = [null, 'lint-on-save', 42, hook({})] as unknown as HookConfig[];
		const result = validateHooks(malformed, REGISTERED);

		assert.deepStrictEqual(
			{
				valid: result.valid.map(h => h.name),
				reasons: result.invalid.map(i => i.reason),
			},
			{
				valid: ['test-hook'],
				reasons: ['hook is not an object', 'hook is not an object', 'hook is not an object'],
			}
		);
	});

	test('skips the agent-registry check when no known agents are provided', () => {
		const result = validateHooks([hook({ agent: 'anton-pentest' })]);
		assert.deepStrictEqual(
			{ valid: result.valid.length, invalid: result.invalid.length },
			{ valid: 1, invalid: 0 }
		);
	});

	test('the shipped hooks.json only references registered agents (F-20)', () => {
		// The registry list mirrors `AGENT_CONFIGS` in
		// `son-of-anton-core/src/agents/AgentStackFactory.ts` — the handles
		// that actually get chat participants. `anton-pentest` is not one.
		const registryHandles = [
			'anton', 'anton-code', 'anton-test', 'anton-security', 'anton-docs',
			'anton-e2e', 'anton-ci', 'anton-pr', 'anton-moderniser',
		];
		const hooksPath = path.join(__dirname, '..', '..', '..', '.son-of-anton', 'hooks.json');
		const config: HooksFileConfig = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));

		const result = validateHooks(config.hooks, registryHandles);
		assert.deepStrictEqual(result.invalid, []);
	});
});
