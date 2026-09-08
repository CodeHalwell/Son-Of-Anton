/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import type { MessageContent, UniformMessage, UniformTool } from './providers/types.js';

export interface RouterMessage {
	role: string;
	content: string | null | Array<Record<string, unknown>>;
	tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
	cache_control?: { type: string };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function requiredString(value: unknown): string { if (typeof value !== 'string' || !value) { throw new Error('Tool names and IDs must be non-empty strings'); } return value; }
export function toolInput(value: unknown): Record<string, unknown> {
	const input = typeof value === 'string' ? JSON.parse(value) : value;
	if (!record(input)) { throw new Error('Tool arguments must be a JSON object'); }
	return input;
}

/** Accept the existing HTTP spellings at one boundary; adapters receive one contract. */
export function normalizeMessages(messages: readonly RouterMessage[]): UniformMessage[] {
	return messages.map(message => {
		if (message.role === 'tool') {
			if (typeof message.content !== 'string') { throw new Error('Tool results must contain text'); }
			return { role: 'user', content: [{ type: 'tool_result', toolUseId: requiredString(message.tool_call_id), content: message.content }] };
		}
		if (!['system', 'user', 'assistant'].includes(message.role)) { throw new Error('Invalid message role'); }
		const role = message.role as UniformMessage['role'];
		if (typeof message.content === 'string' && !message.tool_calls?.length) { return { role, content: message.content }; }
		const content: MessageContent[] = [];
		if (typeof message.content === 'string' && message.content) { content.push({ type: 'text', text: message.content }); }
		else if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (!record(block)) { throw new Error('Invalid message content'); }
				if (block.type === 'text' && typeof block.text === 'string') { content.push({ type: 'text', text: block.text }); }
				else if (block.type === 'tool_use') { content.push({ type: 'tool_use', toolUseId: requiredString(block.toolUseId ?? block.id), name: requiredString(block.name), input: toolInput(block.input) }); }
				else if (block.type === 'tool_result' && typeof block.content === 'string') { content.push({ type: 'tool_result', toolUseId: requiredString(block.toolUseId ?? block.tool_use_id), content: block.content, isError: block.isError === true || block.is_error === true }); }
				else { throw new Error('Unsupported router message content block'); }
			}
		}
		for (const call of message.tool_calls ?? []) { content.push({ type: 'tool_use', toolUseId: requiredString(call.id), name: requiredString(call.function?.name), input: toolInput(call.function?.arguments) }); }
		return { role, content };
	});
}

export function normalizeTools(input: unknown): UniformTool[] | undefined {
	if (input === undefined) { return undefined; }
	if (!Array.isArray(input)) { throw new Error('tools must be an array'); }
	return input.map(tool => {
		if (!record(tool)) { throw new Error('Invalid tool definition'); }
		const spec = record(tool.function) ? tool.function : tool;
		const schema = spec.inputSchema ?? spec.input_schema ?? spec.parameters;
		if (!record(schema)) { throw new Error('Tool input schema must be an object'); }
		return { name: requiredString(spec.name), description: typeof spec.description === 'string' ? spec.description : '', inputSchema: schema };
	});
}
