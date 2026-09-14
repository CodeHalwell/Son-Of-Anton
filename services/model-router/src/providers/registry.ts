/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { AnthropicOAuthAdapter, type BrokerLike, type FetchFn } from './anthropic-oauth.js';
import { ChatGPTOAuthAdapter } from './chatgpt-oauth.js';
import { CopilotAdapter } from './copilot.js';
import { BrokerClient } from './broker-client.js';
import type { ProviderAdapter } from './types.js';
import type { ModelRouter } from '../router.js';

/** Resolve credentials at request time so config reload and broker rotation take effect. */
export function createProviderRegistry(router: ModelRouter, broker: BrokerLike = new BrokerClient()): (id: string) => ProviderAdapter {
	return id => {
		if (id === 'anthropic-oauth') { return new AnthropicOAuthAdapter({ broker }); }
		if (id === 'chatgpt-oauth') { return new ChatGPTOAuthAdapter({ broker }); }
		if (id === 'copilot') { return new CopilotAdapter({ broker }); }
		const config = router.resolveProvider(id);
		const baseUrl = config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
		const fetchFn: FetchFn = (_url, init) => {
			const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
			if (config.format === 'anthropic') {
				headers['anthropic-version'] = '2023-06-01';
				if (config.apiKey) { headers['x-api-key'] = config.apiKey; }
			} else if (config.apiKey) { headers.Authorization = `Bearer ${config.apiKey}`; }
			return fetch(baseUrl + (config.format === 'anthropic' ? '/v1/messages' : '/v1/chat/completions'), { ...init, headers });
		};
		const keyBroker: BrokerLike = { getToken: async () => ({ token: config.apiKey ?? '' }), invalidate: async () => {} };
		const adapter = config.format === 'anthropic' ? new AnthropicOAuthAdapter({ broker: keyBroker, fetchFn }) : new CopilotAdapter({ broker: keyBroker, fetchFn });
		return {
			id, displayName: id,
			isAvailable: async () => !!config.local || !!config.apiKey,
			listModels: async () => [],
			async *send(request, signal) {
				for await (const event of adapter.send(request, signal)) {
					yield event.type === 'message_start' ? { ...event, provider: id, model: request.model } : event;
				}
			},
		};
	};
}
