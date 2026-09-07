/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import type { ChatToolDefinition } from './protocol';
import { postToHost } from './vscode';

/** A streamed board action routed to the extension host. */
export interface ChatToolCall {
	readonly id: string;
	readonly name: string;
	readonly input: Record<string, unknown>;
}

/**
 * Stream a chat completion through the host's `LlmClient`.
 *
 * The webview posts a `chat-runtime` message tagged with a UUID; the host
 * resolves it by streaming `chat-runtime-chunk` events back, which we
 * fan out to the supplied callbacks.
 */
export function requestStream(
	model: string,
	messages: ReadonlyArray<{ role: 'system' | 'user' | 'assistant'; content: string }>,
	callbacks: {
		onToken: (token: string) => void;
		onComplete: (fullText: string) => void;
		onError: (error: string) => void;
		onToolCall?: (call: ChatToolCall) => void;
	},
	tools?: ReadonlyArray<ChatToolDefinition>,
): { cancel: () => void } {
	const requestId = makeRequestId();
	let finished = false;
	const handler = (ev: MessageEvent): void => {
		const data = ev.data as {
			type?: string;
			requestId?: string;
			event?: {
				type: string;
				token?: string;
				fullText?: string;
				error?: string;
				id?: string;
				name?: string;
				input?: Record<string, unknown>;
			};
		} | undefined;
		if (!data || data.type !== 'chat-runtime-chunk' || data.requestId !== requestId) {
			return;
		}
		const event = data.event;
		if (!event) {
			return;
		}
		if (event.type === 'token' && typeof event.token === 'string') {
			callbacks.onToken(event.token);
		} else if (event.type === 'tool-call' && typeof event.name === 'string' && typeof event.id === 'string') {
			callbacks.onToolCall?.({
				id: event.id,
				name: event.name,
				input: event.input && typeof event.input === 'object' ? event.input : {},
			});
		} else if (event.type === 'complete') {
			finished = true;
			window.removeEventListener('message', handler);
			callbacks.onComplete(event.fullText ?? '');
		} else if (event.type === 'error') {
			finished = true;
			window.removeEventListener('message', handler);
			callbacks.onError(event.error ?? 'Unknown error');
		}
	};
	window.addEventListener('message', handler);

	postToHost({ type: 'chat-runtime', requestId, model, messages, tools });

	return {
		cancel: (): void => {
			if (finished) { return; }
			finished = true;
			window.removeEventListener('message', handler);
			postToHost({ type: 'cancel-chat', requestId });
		},
	};
}

function makeRequestId(): string {
	// Webview's `crypto.randomUUID` is available in all modern Electron versions.
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return 'r-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}
