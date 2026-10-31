/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import type { CredentialState } from 'son-of-anton-core/credentials/credentialDetection';
import { maybeShowFirstRunSignInPrompt, type FirstRunDeps } from '../src/auth/firstRun';
import { SETUP_WIZARD_SKIPPED_KEY, SetupWizardPanel, type SetupWizardDeps } from '../src/onboarding/SetupWizardPanel';

suite('Independent runtime first-run setup', () => {
	const emptyState: CredentialState = {
		anthropic: { hasApiKey: false, hasOAuth: false }, openai: { hasApiKey: false, hasOAuth: false },
		google: { hasApiKey: false }, foundry: { hasApiKey: false, hasEndpoint: false }, bedrock: { hasAccessKey: false, hasProfile: false },
		openrouter: { hasApiKey: false }, ollama: { hasBaseUrl: false }, lmstudio: { hasBaseUrl: false }, deepseek: { hasApiKey: false },
		mistral: { hasApiKey: false }, groq: { hasApiKey: false }, cerebras: { hasApiKey: false }, together: { hasApiKey: false },
		fireworks: { hasApiKey: false }, codex: { hasCli: false },
	};
	let original: typeof SetupWizardPanel.createOrShow;
	let opened: SetupWizardDeps[];
	setup(() => { opened = []; original = SetupWizardPanel.createOrShow; SetupWizardPanel.createOrShow = (_context, deps) => { opened.push(deps); }; });
	teardown(() => { SetupWizardPanel.createOrShow = original; });

	function fixture(state: CredentialState) {
		const values = new Map<string, unknown>();
		let reads = 0;
		const deps = {
			context: {
				globalState: { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); } },
				secrets: { get: async () => { throw new Error('Private setup must not inspect native credentials'); } },
			},
			broker: {}, llmClient: {}, getConfig: () => ({}),
			runtimeSetup: { runtime: 'daemon', readCredentialState: async () => { reads++; return state; }, saveCredentials: async () => ({ ok: true, deferred: true, message: 'fixture' }) },
		} as unknown as FirstRunDeps;
		return { deps, values, reads: () => reads };
	}

	test('opens private setup using private readiness even if native credentials could exist', async () => {
		const test = fixture(emptyState);
		await maybeShowFirstRunSignInPrompt(test.deps);
		assert.deepEqual([test.reads(), opened.length, opened[0].runtime, opened[0].saveCredentials], [1, 1, 'daemon', test.deps.runtimeSetup!.saveCredentials]);
	});

	test('does not prompt when the private runtime already has a configured provider', async () => {
		const test = fixture({ ...emptyState, openai: { hasApiKey: true, hasOAuth: false } });
		await maybeShowFirstRunSignInPrompt(test.deps);
		assert.deepEqual([test.reads(), opened.length, test.values.get('sotaAuth.firstRunPromptDismissed')], [1, 0, true]);
	});

	test('preserves a previous explicit setup dismissal without reading either credential store', async () => {
		const test = fixture(emptyState);
		test.values.set(SETUP_WIZARD_SKIPPED_KEY, true);
		await maybeShowFirstRunSignInPrompt(test.deps);
		assert.deepEqual([test.reads(), opened.length], [0, 0]);
	});
});
