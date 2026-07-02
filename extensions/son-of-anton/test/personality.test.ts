/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

suite('Personality', () => {
	// __dirname is the compiled location (out-test/test); resources live at the
	// extension root, two levels up (out-test/test → out-test → son-of-anton).
	const resourcesDir = path.join(__dirname, '..', '..', 'resources');

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

		suiteSetup(() => {
			const raw = fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8');
			packageJson = JSON.parse(raw);
		});

		test('all sota.* commands surface under the Anton brand', () => {
			const commands = packageJson.contributes.commands
				.filter(c => c.command.startsWith('sota.') && !c.command.startsWith('sota.konami'));

			for (const cmd of commands) {
				// A command is on-brand when the "Anton" name appears in its title
				// (e.g. "Anton: Open Chat") or its category (e.g. "Son of Anton",
				// "Anton Roster"). VS Code renders the category as the palette
				// prefix, so either mechanism keeps the command discoverable under
				// the Anton brand.
				const branded = /Anton/.test(cmd.title)
					|| (typeof cmd.category === 'string' && /Anton/.test(cmd.category));
				assert.ok(
					branded,
					`Command "${cmd.command}" (title "${cmd.title}", category "${cmd.category ?? ''}") is not branded under "Anton"`,
				);
			}
		});
	});
});
