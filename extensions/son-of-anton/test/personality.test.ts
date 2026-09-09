/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Son of Anton Contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));

suite('Personality', () => {
	const resourcesDir = path.join(_dir, '..', 'resources');

	suite('startup-messages.json', () => {
		let messages: string[];

		suiteSetup(() => {
			const raw = fs.readFileSync(path.join(resourcesDir, 'startup-messages.json'), 'utf-8');
			messages = JSON.parse(raw);
		});

		test('is a non-empty array of strings', () => {
			assert.ok(Array.isArray(messages));
			assert.ok(messages.length > 0);
			for (const msg of messages) {
				assert.strictEqual(typeof msg, 'string');
				assert.ok(msg.length > 0, 'Each message should be non-empty');
			}
		});

		test('contains at least 10 messages', () => {
			assert.ok(messages.length >= 10, `Expected at least 10 messages, got ${messages.length}`);
		});

		test('messages are short (under 100 characters)', () => {
			for (const msg of messages) {
				assert.ok(msg.length < 100, `Message too long: "${msg}" (${msg.length} chars)`);
			}
		});
	});

	suite('strings.json', () => {
		let strings: Record<string, string>;

		suiteSetup(() => {
			const raw = fs.readFileSync(path.join(resourcesDir, 'strings.json'), 'utf-8');
			strings = JSON.parse(raw);
		});

		test('contains all required keys', () => {
			const requiredKeys = [
				'codeGraphUnavailable',
				'mcpServerTimeout',
				'agentTaskFailedAfterRetries',
				'allAgentsIdle',
				'checkpointRestored',
				'securityScanClean',
				'noProjectOpen',
				'reviewAgentRejectsCode',
				'backgroundAgentCompleted',
				'promptCacheHitRate',
				'fridayAfternoon',
				'allAgentAuthored',
			];

			assert.deepStrictEqual(
				Object.keys(strings).sort(),
				requiredKeys.sort(),
			);
		});

		test('all values are non-empty strings', () => {
			for (const [key, value] of Object.entries(strings)) {
				assert.strictEqual(typeof value, 'string', `${key} should be a string`);
				assert.ok(value.length > 0, `${key} should be non-empty`);
			}
		});

		test('placeholder strings use {0} format', () => {
			assert.ok(strings.backgroundAgentCompleted.includes('{0}'));
			assert.ok(strings.promptCacheHitRate.includes('{0}'));
		});
	});

	suite('Command palette branding', () => {
		let packageJson: { contributes: { commands: Array<{ command: string; title: string; category?: string }> } };
		let labels: Record<string, string>;

		suiteSetup(() => {
			const raw = fs.readFileSync(path.join(_dir, '..', 'package.json'), 'utf-8');
			packageJson = JSON.parse(raw);
			labels = JSON.parse(fs.readFileSync(path.join(_dir, '..', 'package.nls.json'), 'utf-8'));
		});

		test('all sota.* commands retain Anton branding in their title or category', () => {
			const commands = packageJson.contributes.commands
				.filter(c => c.command.startsWith('sota.') && !c.command.startsWith('sota.konami'));

			for (const cmd of commands) {
				const title = cmd.title.startsWith('%') && cmd.title.endsWith('%') ? labels[cmd.title.slice(1, -1)] : cmd.title;
				const category = cmd.category?.startsWith('%') && cmd.category.endsWith('%') ? labels[cmd.category.slice(1, -1)] : cmd.category;
				assert.ok(
					title && (title.startsWith('Anton:') || category === 'Anton' || category === 'Son of Anton'),
					`Command "${cmd.command}" must have an "Anton:" title or an "Anton" / "Son of Anton" command-palette category`,
				);
			}
		});
	});
});
