// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import type { UnifiedResponse } from './types.js';
import type { UniformTool } from './providers/types.js';
import { normalizeMessages, toolInput, type RouterMessage } from './messageContract.js';
import { buildAnthropicRequest } from './providers/anthropic-oauth.js';
import { buildCopilotRequest } from './providers/copilot.js';

interface AnthropicContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: string;
	is_error?: boolean;
	cache_control?: { type: string };
}

interface AnthropicMessage {
	role: string;
	content: string | AnthropicContentBlock[];
	cache_control?: { type: string };
}

interface AnthropicRequest {
	model: string;
	max_tokens: number;
	system?: string | AnthropicContentBlock[];
	messages: AnthropicMessage[];
	stream?: boolean;
	tools?: Array<Record<string, unknown>>;
	stream_options?: { include_usage: boolean };
}

interface OpenAIRequest {
	model: string;
	max_tokens: number;
	messages: ReturnType<typeof buildCopilotRequest>['messages'];
	stream?: boolean;
	tools?: ReturnType<typeof buildCopilotRequest>['tools'];
	stream_options?: { include_usage: boolean };
}

export function toAnthropicFormat(
	messages: RouterMessage[],
	systemPrompt: string | undefined,
	maxTokens: number,
	model: string,
	stream?: boolean,
	tools?: readonly UniformTool[],
): AnthropicRequest {
	const anthropicMessages: AnthropicMessage[] = [];
	let system: string | AnthropicContentBlock[] | undefined = systemPrompt;

	for (const msg of messages) {
		if (msg.role === 'system') {
			if (typeof msg.content !== 'string') { throw new Error('System messages must contain text'); }
			// Extract system messages separately for Anthropic format
			if (msg.cache_control) {
				const block: AnthropicContentBlock = {
					type: 'text',
					text: msg.content,
					cache_control: msg.cache_control,
				};
				if (typeof system === 'string' && system) {
					system = [{ type: 'text', text: system }, block];
				} else if (Array.isArray(system)) {
					system = [...system, block];
				} else {
					system = [block];
				}
			} else {
				if (typeof system === 'string') {
					system = system ? `${system}\n${msg.content}` : msg.content;
				} else if (Array.isArray(system)) {
					system = [...system, { type: 'text', text: msg.content }];
				} else {
					system = msg.content;
				}
			}
			continue;
		}

		const normalized = normalizeMessages([msg]);
		const converted = buildAnthropicRequest({ requestId: 'translation', model, messages: normalized }).messages[0];
		const anthropicMsg: AnthropicMessage = {
			role: converted.role,
			content: typeof msg.content === 'string' && !msg.tool_calls?.length && msg.role !== 'tool' ? msg.content : converted.content,
		};

		if (msg.cache_control && typeof msg.content === 'string') {
			anthropicMsg.content = [{
				type: 'text',
				text: msg.content,
				cache_control: msg.cache_control,
			}];
		}

		anthropicMessages.push(anthropicMsg);
	}

	const request: AnthropicRequest = {
		model,
		max_tokens: maxTokens,
		messages: anthropicMessages,
	};

	if (system) {
		request.system = system;
	}

	if (stream !== undefined) {
		request.stream = stream;
	}

	if (tools?.length) { request.tools = tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })); }
	return request;
}

export function toOpenAIFormat(
	messages: RouterMessage[],
	systemPrompt: string | undefined,
	maxTokens: number,
	model: string,
	stream?: boolean,
	tools?: readonly UniformTool[],
): OpenAIRequest {
	const converted = buildCopilotRequest({ requestId: 'translation', model, messages: normalizeMessages(messages), system: systemPrompt, tools });
	const openaiMessages = converted.messages;

	const request: OpenAIRequest = {
		model,
		max_tokens: maxTokens,
		messages: openaiMessages,
	};

	if (stream !== undefined) {
		request.stream = stream;
	}

	if (tools?.length) { request.tools = converted.tools; }
	if (stream) { request.stream_options = { include_usage: true }; }
	return request;
}

export function fromAnthropicResponse(response: Record<string, unknown>): UnifiedResponse {
	const content = response.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
	const textContent = content
		?.filter(block => block.type === 'text')
		.map(block => block.text ?? '')
		.join('') ?? '';

	const usage = response.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;

	return {
		content: textContent,
		...(content?.some(block => block.type === 'tool_use') ? { toolCalls: content.filter(block => block.type === 'tool_use').map(block => ({ id: block.id ?? '', name: block.name ?? '', input: toolInput(block.input) })) } : {}),
		model: response.model as string ?? '',
		inputTokens: usage?.input_tokens ?? 0,
		outputTokens: usage?.output_tokens ?? 0,
		cachedTokens: usage?.cache_read_input_tokens ?? 0,
		cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
		finishReason: response.stop_reason as string ?? 'unknown',
	};
}

export function fromOpenAIResponse(response: Record<string, unknown>): UnifiedResponse {
	const choices = response.choices as Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>;
	const firstChoice = choices?.[0];

	const usage = response.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;

	return {
		content: firstChoice?.message?.content ?? '',
		...(firstChoice?.message?.tool_calls?.length ? { toolCalls: firstChoice.message.tool_calls.map(call => ({ id: call.id, name: call.function.name, input: toolInput(call.function.arguments) })) } : {}),
		model: response.model as string ?? '',
		inputTokens: usage?.prompt_tokens ?? 0,
		outputTokens: usage?.completion_tokens ?? 0,
		cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
		cacheCreationTokens: 0,
		finishReason: firstChoice?.finish_reason ?? 'unknown',
	};
}
