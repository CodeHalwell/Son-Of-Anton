/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * @fileoverview postMessage protocol shared between TaskBoardPanel.ts and
 * the React webview app. Mirrors the host's existing message contracts.
 */

export type SubtaskState =
	| 'backlog'
	| 'ready'
	| 'in-progress'
	| 'review'
	| 'done'
	| 'failed';

export interface BoardTaskView {
	readonly id: string;
	readonly instruction: string;
	readonly assignee: string;
	readonly scopeFiles: ReadonlyArray<string>;
	readonly dependencies: ReadonlyArray<string>;
	readonly state: SubtaskState;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly summary?: string;
	proposalId?: string;
	readonly tokenUsage?: { input: number; output: number };
}

export interface BoardSnapshotView {
	readonly conversationId: string;
	readonly createdAt: number;
	readonly tasks: ReadonlyArray<BoardTaskView>;
}

export interface PersonaView {
	readonly id: string;
	readonly monogram: string;
	readonly accent: string;
	readonly tagline: string;
}

/** Host -> webview: snapshot push. */
export interface SnapshotMessage {
	readonly type: 'snapshot';
	readonly conversationId: string | null;
	readonly conversationTitle: string;
	readonly snapshot: BoardSnapshotView | null;
	readonly personas: ReadonlyArray<PersonaView>;
}

/** Host -> webview: a streamed chat-runtime chunk for a pending request. */
export interface ChatRuntimeChunkMessage {
	readonly type: 'chat-runtime-chunk';
	readonly requestId: string;
	readonly event:
		| { readonly type: 'token'; readonly token: string }
		| { readonly type: 'complete'; readonly fullText: string }
		| { readonly type: 'error'; readonly error: string }
		| {
			readonly type: 'tool-call';
			readonly id: string;
			readonly name: string;
			readonly input: Record<string, unknown>;
		};
}

/**
 * Loose JSON-Schema tool definition shape forwarded from the webview to
 * the host. Mirrors `LlmClient.ToolDefinition` structurally — keeping
 * the surface narrow lets us avoid pulling a core dep into the protocol
 * module.
 */
export interface ChatToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		readonly required?: ReadonlyArray<string>;
	};
}

export type HostToWebviewMessage = SnapshotMessage | ChatRuntimeChunkMessage;

/** Webview -> host: drag-drop / button actions on the existing protocol. */
export interface DispatchMessage { readonly type: 'dispatch'; readonly taskId: string }
export interface ReassignMessage { readonly type: 'reassign'; readonly taskId: string; readonly newAssignee: string }
export interface RerunMessage { readonly type: 'rerun'; readonly taskId: string }
export interface RevealMessage { readonly type: 'reveal'; readonly taskId: string }
export interface RefreshMessage { readonly type: 'refresh' }
export interface OpenChatMessage { readonly type: 'open-chat' }
export interface CancelChatMessage { readonly type: 'cancel-chat'; readonly requestId: string }

/** Webview -> host: agent-driven board mutations (CopilotKit actions). */
export type BoardActionName =
	| 'moveCard'
	| 'addCard'
	| 'setCardStatus'
	| 'setCardAssignee'
	| 'setCardPriority';

export interface BoardActionMessage {
	readonly type: 'board-action';
	readonly action: BoardActionName;
	readonly cardId?: string;
	readonly toColumn?: SubtaskState;
	readonly assignee?: string;
	readonly priority?: 'low' | 'medium' | 'high';
	readonly instruction?: string;
}

/** Webview -> host: chat-runtime invocation (streamed LLM call). */
export interface ChatRuntimeRequestMessage {
	readonly type: 'chat-runtime';
	readonly requestId: string;
	readonly model: string;
	readonly messages: ReadonlyArray<{ readonly role: 'system' | 'user' | 'assistant'; readonly content: string }>;
	readonly tools?: ReadonlyArray<ChatToolDefinition>;
}

export type WebviewToHostMessage = (
	| { readonly type: 'review-proposal' | 'cancel-task'; readonly taskId: string }
	| DispatchMessage
	| ReassignMessage
	| RerunMessage
	| RevealMessage
	| RefreshMessage
	| OpenChatMessage
	| { readonly type: 'review-council' }
	| CancelChatMessage
	| BoardActionMessage
	| ChatRuntimeRequestMessage
) & { readonly conversationId?: string | null };

/** Validate untrusted postMessage data once, before narrowing to the shared contract. */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
	const message = value as Record<string, unknown>;
	if (message.conversationId !== undefined && message.conversationId !== null && typeof message.conversationId !== 'string') { return false; }
	const text = (field: string): boolean => typeof message[field] === 'string' && (message[field] as string).length > 0;
	switch (message.type) {
		case 'refresh': case 'open-chat': case 'review-council': return true;
		case 'review-proposal': case 'cancel-task': case 'dispatch': case 'rerun': case 'reveal': return text('taskId');
		case 'reassign': return text('taskId') && text('newAssignee');
		case 'cancel-chat': return text('requestId');
		case 'board-action':
			switch (message.action) {
				case 'moveCard': case 'setCardStatus': return text('cardId') && ['backlog', 'ready', 'in-progress', 'review', 'done', 'failed'].includes(String(message.toColumn));
				case 'setCardAssignee': return text('cardId') && text('assignee');
				case 'setCardPriority': return text('cardId') && ['low', 'medium', 'high'].includes(String(message.priority));
				case 'addCard': return text('instruction') && (message.assignee === undefined || text('assignee'));
				default: return false;
			}
		case 'chat-runtime':
			return text('requestId') && typeof message.model === 'string' && Array.isArray(message.messages) && message.messages.length > 0 && message.messages.length <= 1000
				&& message.messages.every(entry => entry && ['system', 'user', 'assistant'].includes(entry.role) && typeof entry.content === 'string')
				&& (message.tools === undefined || (Array.isArray(message.tools) && message.tools.every(tool => tool && typeof tool.name === 'string' && typeof tool.description === 'string' && tool.inputSchema?.type === 'object' && tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object' && !Array.isArray(tool.inputSchema.properties) && (tool.inputSchema.required === undefined || (Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.every((key: unknown) => typeof key === 'string'))))));
		default: return false;
	}
}
