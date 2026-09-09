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
	/** Selected only from the session’s advertised model IDs. */
	modelId?: string;
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
export interface AcpImage { data: string; mimeType: string }
export interface AcpCapabilities {
	transport: 'native' | 'acp';
	images: boolean | 'unknown';
	plan: boolean | 'unknown';
	resume: boolean | 'unknown';
	metering: 'estimated' | 'unavailable' | 'reported';
	error?: string;
	models?: Array<{ id: string; name: string }>;
}
export interface AcpUsage {
	/** These are context occupancy values, not billed input/output token counts. */
	contextTokens?: number;
	contextWindow?: number;
	/** Adapter-reported cumulative session cost. Never treated as a subscription invoice. */
	cost?: { amount: number; currency: string };
}
export interface AcpPromptResult { stopReason: AcpStopReason }

/** Validate before spawning an adapter; an invalid attachment must never silently disappear. */
export function validateImages(images: readonly AcpImage[] = []): void {
	if (images.length > 10) { throw new Error('A turn supports at most 10 images'); }
	let bytes = 0;
	for (const image of images) {
		if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mimeType) || !image.data || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) {
			throw new Error('Image attachments require valid base64 PNG, JPEG, WebP or GIF content');
		}
		bytes += Buffer.byteLength(image.data);
	}
	if (bytes > 24 * 1024 * 1024) { throw new Error('Image attachments exceed the 24 MiB encoded turn limit'); }
}
export class AcpError extends Error {
	constructor(readonly code: number, message: string, readonly data?: unknown) { super(message); this.name = 'AcpError'; }
}
export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function abortError(): Error { return new DOMException('ACP request cancelled', 'AbortError'); }
export const cancelledPermission = (): AcpPermissionResult => ({ outcome: { outcome: 'cancelled' } });

/** The limit applies to the adapter's raw model ID, excluding host catalog namespaces. */
export function isValidAcpModelId(value: unknown): value is string {
	return typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

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
	if (value.modelId !== undefined && !isValidAcpModelId(value.modelId)) {
		throw new Error(`ACP agent ${value.id}: modelId must be a non-empty advertised model ID`);
	}
	if (value.authMethodId !== undefined && typeof value.authMethodId !== 'string') {
		throw new Error(`ACP agent ${value.id}: authMethodId must be a string`);
	}
}
