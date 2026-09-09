/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Existing native alias support, independent of a configured invocation ID or profile ARN. */
const claudeFamilies: Readonly<Record<string, { tools: true; images: boolean }>> = {
	'bedrock-claude-opus-4': { tools: true, images: true },
	'bedrock-claude-sonnet-4': { tools: true, images: true },
	'bedrock-claude-haiku-4': { tools: true, images: true },
	'bedrock-claude-3-7-sonnet': { tools: true, images: true },
	'bedrock-claude-sonnet': { tools: true, images: true },
	// Preserve the native legacy Haiku alias's conservative image gate.
	'bedrock-claude-haiku': { tools: true, images: false },
};

/** Only known semantic aliases carry tool/image capabilities; opaque IDs imply neither. */
export function bedrockFamilyCapabilities(family: string | undefined): Readonly<{ tools: true; images: boolean }> | undefined {
	return family && Object.hasOwn(claudeFamilies, family) ? claudeFamilies[family] : undefined;
}

/** The adapter implements Claude Messages. A configured family can identify an opaque profile. */
export function supportsBedrockClaude(family: string | undefined, invocationId: string | undefined): boolean {
	return family?.startsWith('bedrock-claude-') === true || invocationId?.includes('anthropic.claude') === true;
}

/** Distinguish explicit adapter model families from friendly labels such as bedrock-production. */
export function isBedrockSemanticFamily(family: string): boolean {
	return /^bedrock-(?:claude|llama|mistral|titan|cohere|nova)(?:-|$)/.test(family);
}
