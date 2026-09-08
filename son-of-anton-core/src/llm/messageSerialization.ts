/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import type { LlmContentPart, LlmMessage, LlmMessageContent } from './LlmClient';

export function applyImageCapability(content: LlmMessageContent, supportsImages: boolean): readonly LlmContentPart[] {
	const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
	if (supportsImages || !parts.some(part => part.type === 'image')) { return parts; }
	return [...parts.filter(part => part.type !== 'image'), { type: 'text', text: '[image attachment was not sent: model does not support multimodal input]' }];
}

type OpenAIContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
interface OpenAIMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string | OpenAIContent[] | null;
	reasoning_content?: string;
	tool_call_id?: string;
	tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

/** Tool replies are separate role=tool messages, correlated by the original call id. */
export function serializeOpenAIMessages(messages: readonly LlmMessage[], supportsImages: boolean): OpenAIMessage[] {
	const output: OpenAIMessage[] = [];
	for (const message of messages) {
		if (typeof message.content === 'string') { output.push({ role: message.role, content: message.content, ...(message.role === 'assistant' && message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}) }); continue; }
		const content: OpenAIContent[] = [];
		const calls: NonNullable<OpenAIMessage['tool_calls']> = [];
		for (const part of applyImageCapability(message.content, supportsImages)) {
			switch (part.type) {
				case 'text': content.push({ type: 'text', text: part.text }); break;
				case 'image': content.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.base64Data}` } }); break;
				case 'tool_use':
					if (message.role !== 'assistant') { throw new Error('Tool calls must belong to assistant messages'); }
					calls.push({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
					break;
				case 'tool_result':
					if (message.role !== 'user') { throw new Error('Tool results must belong to user messages'); }
					output.push({ role: 'tool', tool_call_id: part.tool_use_id, content: part.content });
					break;
			}
		}
		if (content.length || calls.length) { output.push({ role: message.role, content: content.length ? content : null, ...(message.role === 'assistant' && message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}), ...(calls.length ? { tool_calls: calls } : {}) }); }
	}
	return output;
}

type GooglePart =
	| { text: string }
	| { inline_data: { mime_type: string; data: string } }
	| { functionCall: { name: string; args: Record<string, unknown> }; thoughtSignature?: string }
	| { functionResponse: { name: string; response: { result?: string; error?: string } } };

/** Gemini correlates results by function name; retain signatures on function-call parts. */
export function serializeGoogleMessages(messages: readonly LlmMessage[], supportsImages: boolean): Array<{ role: 'model' | 'user'; parts: GooglePart[] }> {
	const calls = new Map<string, string>();
	return messages.map(message => {
		const parts: GooglePart[] = applyImageCapability(message.content, supportsImages).map(part => {
			switch (part.type) {
				case 'text': return { text: part.text };
				case 'image': return { inline_data: { mime_type: part.mimeType, data: part.base64Data } };
				case 'tool_use':
					calls.set(part.id, part.name);
					return { functionCall: { name: part.name, args: part.input }, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
				case 'tool_result': {
					const name = calls.get(part.tool_use_id);
					if (!name) { throw new Error(`Tool result has no matching call: ${part.tool_use_id}`); }
					return { functionResponse: { name, response: part.is_error ? { error: part.content } : { result: part.content } } };
				}
			}
		});
		return { role: message.role === 'assistant' ? 'model' : 'user', parts };
	});
}

/** Invalid argument JSON must never become an executable empty argument object. */
export function parseToolArguments(json: string, name: string | undefined): Record<string, unknown> {
	if (!name) { throw new Error('Provider returned a tool call without a name'); }
	let input: unknown;
	try { input = JSON.parse(json || '{}'); }
	catch { throw new Error(`Provider returned malformed arguments for tool ${name}`); }
	if (!input || typeof input !== 'object' || Array.isArray(input)) { throw new Error(`Provider returned non-object arguments for tool ${name}`); }
	return input as Record<string, unknown>;
}
