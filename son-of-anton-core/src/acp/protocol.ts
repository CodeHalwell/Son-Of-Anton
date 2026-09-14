/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Stable ACP v1 subset. Optional extensions are negotiated, never assumed. */
export const ACP_VERSION = 1;
export interface AcpAgentDefinition {
	id: string;
	command: string;
	args?: string[];
	env?: Record<string, string>;
	/** Explicitly chosen from the agent's advertised authentication methods. */
	authMethodId?: string;
}
export interface AcpMcpServer {
	name: string;
	command: string;
	args: string[];
	env: Array<{ name: string; value: string }>;
}
export interface AcpInitializeResult {
	protocolVersion: number;
	agentCapabilities?: {
		loadSession?: boolean;
		promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
	};
	agentInfo?: { name: string; version: string; title?: string };
	authMethods?: Array<{ id: string; name: string; description?: string }>;
}
export interface AcpUpdate {
	sessionUpdate: string;
	content?: { type: string; text?: string } | unknown[];
	toolCallId?: string;
	title?: string;
	status?: string;
	kind?: string;
	[key: string]: unknown;
}
export interface AcpPermissionRequest {
	sessionId: string;
	toolCall: { toolCallId: string; title?: string; kind?: string; [key: string]: unknown };
	options: Array<{ optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }>;
}
export type AcpPermissionResult = { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } };
export type AcpPermissionHandler = (request: AcpPermissionRequest, signal: AbortSignal) => Promise<AcpPermissionResult>;
export type AcpStopReason = 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'max_turn_requests';
export interface AcpPromptResult { stopReason: AcpStopReason }
export class AcpError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'AcpError'; }
}
export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function abortError(): Error { return new DOMException('ACP request cancelled', 'AbortError'); }
export const cancelledPermission = (): AcpPermissionResult => ({ outcome: { outcome: 'cancelled' } });

export function validateAgent(value: unknown): asserts value is AcpAgentDefinition {
	if (!object(value) || typeof value.id !== 'string' || !value.id.trim() || typeof value.command !== 'string' || !value.command.trim()) {
		throw new Error('ACP agent requires a non-empty id and command');
	}
	if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(arg => typeof arg === 'string'))) {
		throw new Error(`ACP agent ${value.id}: args must be strings`);
	}
	if (value.env !== undefined && (!object(value.env) || !Object.values(value.env).every(item => typeof item === 'string'))) {
		throw new Error(`ACP agent ${value.id}: env must map names to strings`);
	}
	if (value.authMethodId !== undefined && typeof value.authMethodId !== 'string') {
		throw new Error(`ACP agent ${value.id}: authMethodId must be a string`);
	}
}
