/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure validation for `.son-of-anton/hooks.json` (F-21).
 *
 * Deliberately free of any `vscode` import so it can be unit-tested outside
 * the extension host. `HookEngine` re-exports these types for compatibility.
 */

/**
 * Trigger events that hooks can respond to.
 */
export type HookTrigger =
	| 'onFileSave'
	| 'preCommit'
	| 'onTestFailure'
	| 'onPRCreate'
	| 'onAgentStart'
	| 'onAgentComplete';

const KNOWN_TRIGGERS: readonly HookTrigger[] = [
	'onFileSave',
	'preCommit',
	'onTestFailure',
	'onPRCreate',
	'onAgentStart',
	'onAgentComplete',
];

/**
 * A hook definition as specified in .son-of-anton/hooks.json.
 */
export interface HookConfig {
	name: string;
	trigger: HookTrigger;
	filter?: string;
	agent: string;
	instruction: string;
	blocking: boolean;
}

/**
 * The full hooks configuration file structure.
 */
export interface HooksFileConfig {
	hooks: HookConfig[];
}

export interface InvalidHook {
	hook: HookConfig;
	reason: string;
}

export interface HookValidationResult {
	valid: HookConfig[];
	invalid: InvalidHook[];
}

/**
 * Validate hook definitions against the set of registered agent handles.
 *
 * A hook that names an unregistered agent would otherwise fail silently at
 * fire time (F-20: `anton-pentest` sat in hooks.json for months with no
 * matching participant). Invalid hooks are separated out with a reason so the
 * caller can warn visibly and register only the valid ones.
 *
 * When `knownAgents` is undefined the agent check is skipped (the registry
 * isn't known yet); structural checks still apply.
 */
export function validateHooks(
	hooks: readonly HookConfig[],
	knownAgents?: readonly string[],
): HookValidationResult {
	const valid: HookConfig[] = [];
	const invalid: InvalidHook[] = [];

	for (const hook of hooks) {
		const reason = validateHook(hook, knownAgents);
		if (reason === undefined) {
			valid.push(hook);
		} else {
			invalid.push({ hook, reason });
		}
	}

	return { valid, invalid };
}

function validateHook(hook: HookConfig, knownAgents?: readonly string[]): string | undefined {
	// hooks.json is user-controlled: entries can be null, strings, etc.
	if (!hook || typeof hook !== 'object') {
		return 'hook is not an object';
	}
	if (!hook.name || typeof hook.name !== 'string') {
		return 'hook has no name';
	}
	if (!KNOWN_TRIGGERS.includes(hook.trigger)) {
		return `unknown trigger '${hook.trigger}' (expected one of: ${KNOWN_TRIGGERS.join(', ')})`;
	}
	if (!hook.agent || typeof hook.agent !== 'string') {
		return 'hook has no agent';
	}
	if (!hook.instruction || typeof hook.instruction !== 'string') {
		return 'hook has no instruction';
	}
	if (knownAgents !== undefined && !knownAgents.includes(hook.agent)) {
		return `agent '${hook.agent}' is not a registered participant (registered: ${knownAgents.join(', ')})`;
	}
	return undefined;
}
