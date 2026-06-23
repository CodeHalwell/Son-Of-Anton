// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ModelRoutesConfig, ProviderConfig, RoutingContext } from './types.js';
import { ModelRouter } from './router.js';
import { MetricsCollector, calculateCost } from './metrics.js';
import { toAnthropicFormat, toOpenAIFormat, fromAnthropicResponse, fromOpenAIResponse } from './translators.js';
import type { FailoverConfig } from './failover/types.js';
import { counter, gauge, histogram, expressMetricsMiddleware, prometheusHandler } from '../_lib/metrics/dist/index.js';
import { expressTracingMiddleware, extractOrCreateTraceContext, addTraceHeaders } from '../_lib/tracing/dist/index.js';
import type { UsageObserver } from './providers/types.js';

function loadConfig(): ModelRoutesConfig {
	const configPath = process.env.MODEL_ROUTES_CONFIG
		?? (process.env.NODE_ENV === 'production' ? '/app/config/routes.json' : './config/model-routes.json');

	const raw = readFileSync(configPath, 'utf-8');
	return JSON.parse(raw) as ModelRoutesConfig;
}

function loadFailoverConfig(): FailoverConfig {
	const explicitPath = process.env.MODEL_FAILOVER_CONFIG;
	const candidates = [
		explicitPath,
		join(process.cwd(), '.son-of-anton', 'routing.json'),
		join(process.cwd(), '..', '..', '.son-of-anton', 'routing.json'),
	].filter((p): p is string => typeof p === 'string');

	for (const path of candidates) {
		if (existsSync(path)) {
			try {
				return JSON.parse(readFileSync(path, 'utf-8')) as FailoverConfig;
			} catch (err) {
				if (path === explicitPath) {
					// Explicit path must be readable — surface this loudly.
					console.error(`[failover] Failed to parse explicit failover config at ${path}:`, (err as Error).message);
				} else {
					console.warn(`[failover] Skipping unreadable failover config at ${path}:`, (err as Error).message);
				}
			}
		}
	}
	return {};
}

interface ResolvedProvider {
	provider: string;
	model: string;
	config: ProviderConfig;
}

/**
 * Builds the ordered list of providers to try for a given agent role.
 *
 * Primary source: `routing.json` failover chain for the role (or "*" catch-all).
 * Fallback: the single route resolved by ModelRouter (legacy API-key path).
 *
 * Entries in routing.json that reference providers not present in
 * model-routes.json are silently skipped — this allows routing.json to
 * include future OAuth provider IDs before the adapter registry is wired in.
 */
function resolveProvidersForRole(
	agentRole: string,
	context: RoutingContext,
	router: ModelRouter,
	failoverConfig: FailoverConfig,
): ResolvedProvider[] {
	const roleConfig = failoverConfig[agentRole] ?? failoverConfig['*'];

	if (roleConfig?.primary) {
		const fallbackList = Array.isArray(roleConfig.fallback) ? roleConfig.fallback : [];
		const entries = [roleConfig.primary, ...fallbackList];
		const resolved: ResolvedProvider[] = [];
		for (const entry of entries) {
			if (!entry?.provider || !entry?.model) {
				continue;
			}
			try {
				const config = router.resolveProvider(entry.provider);
				resolved.push({ provider: entry.provider, model: entry.model, config });
			} catch {
				// Provider not yet registered in model-routes.json — skip gracefully.
			}
		}
		if (resolved.length > 0) {
			return resolved;
		}
	}

	// Legacy fallback: use ModelRouter to resolve the primary route.
	const route = router.resolveRoute(context);
	return [{ provider: route.provider, model: route.model, config: route.providerConfig }];
}

function buildRequestHeaders(config: ProviderConfig): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.apiKey) {
		if (config.format === 'anthropic') {
			headers['x-api-key'] = config.apiKey;
			headers['anthropic-version'] = '2023-06-01';
		} else {
			headers['Authorization'] = `Bearer ${config.apiKey}`;
		}
	}
	return headers;
}

function buildEndpoint(config: ProviderConfig): string {
	return config.format === 'anthropic'
		? `${config.baseUrl}/v1/messages`
		: `${config.baseUrl}/v1/chat/completions`;
}

const llmRequestTotal = counter('llm_requests_total', 'Total LLM requests by provider, model, agent role, and outcome');
const llmRequestDuration = histogram('llm_request_duration_ms', 'LLM request end-to-end latency in milliseconds');
const llmInputTokens = counter('llm_input_tokens_total', 'Total LLM input tokens consumed');
const llmOutputTokens = counter('llm_output_tokens_total', 'Total LLM output tokens generated');
const llmCacheReadTokens = counter('llm_cache_read_tokens_total', 'Total LLM tokens read from prompt cache');
const llmCacheCreationTokens = counter('llm_cache_creation_tokens_total', 'Total LLM tokens written to prompt cache');
const llmCacheHitRate = gauge('llm_cache_hit_rate', 'Cache hit rate: cache_read_tokens / (input_tokens + cache_read_tokens)');

function createPrometheusUsageObserver(): UsageObserver {
	return {
		recordUsage(usage) {
			const labels = { provider: usage.provider, model: usage.model, agent_role: usage.agentRole };
			if (usage.inputTokens > 0) { llmInputTokens.inc(labels, usage.inputTokens); }
			if (usage.outputTokens > 0) { llmOutputTokens.inc(labels, usage.outputTokens); }
			if (usage.cacheReadInputTokens > 0) { llmCacheReadTokens.inc(labels, usage.cacheReadInputTokens); }
			if (usage.cacheCreationInputTokens > 0) { llmCacheCreationTokens.inc(labels, usage.cacheCreationInputTokens); }
			if (usage.cacheReadInputTokens > 0) {
				const total = usage.inputTokens + usage.cacheReadInputTokens;
				if (total > 0) { llmCacheHitRate.set(usage.cacheReadInputTokens / total, labels); }
			}
		},
	};
}

export function createServer() {
	const config = loadConfig();
	let failoverConfig = loadFailoverConfig();
	const router = new ModelRouter(config);
	const metrics = new MetricsCollector();
	const app = express();

	app.use(express.json({ limit: '10mb' }));
	app.use(expressTracingMiddleware('model-router'));
	app.use(expressMetricsMiddleware('model-router'));

	// Health endpoint
	app.get('/health', (_req, res) => {
		res.json({ status: 'ok', service: 'model-router' });
	});

	// Main routing endpoint
	app.post('/v1/messages', async (req, res) => {
		const context: RoutingContext = {
			agentRole: (req.headers['x-agent-role'] as string) ?? 'default',
			taskType: req.headers['x-task-type'] as string | undefined,
			taskId: req.headers['x-task-id'] as string | undefined,
		};

		const traceCtx = extractOrCreateTraceContext(req);
		const isStreaming = req.body.stream === true;
		const startTime = Date.now();
		const messages = req.body.messages ?? [];
		const systemPrompt = req.body.system;
		const maxTokens = req.body.max_tokens ?? 4096;

		// Abort upstream provider connections when the client disconnects (e.g.
		// user clicks Cancel). Without this the provider fetch runs to completion,
		// burning tokens and keeping the connection alive unnecessarily.
		const reqAbort = new AbortController();
		// Only abort when the response is still in-flight — if the response
		// already ended normally, ignore the close event.
		req.on('close', () => { if (!res.writableEnded) { reqAbort.abort(); } });

		const providers = resolveProvidersForRole(context.agentRole, context, router, failoverConfig);

		let lastError: Error | null = null;
		let lastProvider = providers[0]?.provider ?? 'unknown';
		let lastModel = providers[0]?.model ?? 'unknown';

		for (const { provider, model, config: providerConfig } of providers) {
			lastProvider = provider;
			lastModel = model;

			try {
				if (reqAbort.signal.aborted) {
					return;
				}

				const translatedBody = providerConfig.format === 'anthropic'
					? toAnthropicFormat(messages, systemPrompt, maxTokens, model, isStreaming)
					: toOpenAIFormat(messages, systemPrompt, maxTokens, model, isStreaming);

				const headers = addTraceHeaders(buildRequestHeaders(providerConfig), traceCtx);
				const endpoint = buildEndpoint(providerConfig);

				const fetchResponse = await fetch(endpoint, {
					method: 'POST',
					headers,
					body: JSON.stringify(translatedBody),
					signal: reqAbort.signal,
				});

				if (!fetchResponse.ok) {
					const errorBody = await fetchResponse.text();
					// 5xx = server error; 429 = rate-limited — both warrant trying the next provider.
					const retryable = fetchResponse.status >= 500 || fetchResponse.status === 429;
					lastError = new Error(`Provider ${provider} returned ${fetchResponse.status}: ${errorBody}`);
					if (!retryable) {
						// Client error — do not try fallbacks
						break;
					}
					// Server error or rate-limit — try next provider
					continue;
				}

				if (isStreaming) {
					if (!res.headersSent) {
						res.setHeader('Content-Type', 'text/event-stream');
						res.setHeader('Cache-Control', 'no-cache');
						res.setHeader('Connection', 'keep-alive');
					}

					try {
						const body = fetchResponse.body as unknown as AsyncIterable<Buffer> | null;
						if (body) {
							for await (const chunk of body) {
								if (reqAbort.signal.aborted) {
									break;
								}
								res.write(chunk);
							}
						}
						if (!reqAbort.signal.aborted) {
							res.end();
						}
						return;
					} catch (streamErr) {
						const err = streamErr as Error;
						if (err.name === 'AbortError') {
							// Client cancelled mid-stream. Emit final events if the
							// socket is still open (e.g. server-initiated abort), then
							// bail — never retry after a client cancellation.
							if (!reqAbort.signal.aborted && !res.writableEnded) {
								try {
									res.write(`data: ${JSON.stringify({ type: 'message_stop', stopReason: 'error' })}\n\n`);
									res.write(`data: ${JSON.stringify({ type: 'error', code: 'cancelled', message: 'Request cancelled', retryable: false })}\n\n`);
									res.end();
								} catch {
									// socket already closed — nothing to write
								}
							}
							return;
						}
						lastError = err;
						console.error(`Stream from ${provider} failed mid-flight:`, lastError.message);
						// Continue to next provider if headers have not been sent yet,
						// or if the connection is still writable.
						if (res.headersSent && !res.writableEnded) {
							continue;
						}
						// Response already ended — cannot recover.
						return;
					}
				}

				// Non-streaming response
				const responseBody = await fetchResponse.json() as Record<string, unknown>;
				const unified = providerConfig.format === 'anthropic'
					? fromAnthropicResponse(responseBody)
					: fromOpenAIResponse(responseBody);

				const latencyMs = Date.now() - startTime;
				const cost = calculateCost(model, unified.inputTokens, unified.outputTokens, unified.cachedTokens);

				metrics.record({
					id: randomUUID(),
					timestamp: Date.now(),
					provider,
					model,
					agentRole: context.agentRole,
					taskType: context.taskType ?? '',
					taskId: context.taskId ?? '',
					inputTokens: unified.inputTokens,
					outputTokens: unified.outputTokens,
					cachedTokens: unified.cachedTokens,
					cacheCreationTokens: unified.cacheCreationTokens ?? 0,
					latencyMs,
					cost,
					success: true,
				});

				const successLabels = { provider, model, agent_role: context.agentRole, outcome: 'success' };
				llmRequestTotal.inc(successLabels);
				llmRequestDuration.observe(latencyMs, successLabels);
				const tokenLabels = { provider, model, agent_role: context.agentRole };
				if (unified.inputTokens > 0) { llmInputTokens.inc(tokenLabels, unified.inputTokens); }
				if (unified.outputTokens > 0) { llmOutputTokens.inc(tokenLabels, unified.outputTokens); }
				if (unified.cachedTokens > 0) {
					llmCacheReadTokens.inc(tokenLabels, unified.cachedTokens);
					const total = unified.inputTokens + unified.cachedTokens;
					if (total > 0) { llmCacheHitRate.set(unified.cachedTokens / total, tokenLabels); }
				}
				if ((unified.cacheCreationTokens ?? 0) > 0) { llmCacheCreationTokens.inc(tokenLabels, unified.cacheCreationTokens!); }

				res.json(unified);
				return;

			} catch (err) {
				// Client disconnected before the provider responded — bail immediately.
				// Never retry with other providers for a cancelled request.
				if ((err as Error).name === 'AbortError') {
					return;
				}
				lastError = err as Error;
				console.error(`Provider ${provider} failed:`, lastError.message);
				const errLatencyMs = Date.now() - startTime;
				metrics.record({
					id: randomUUID(),
					timestamp: Date.now(),
					provider,
					model,
					agentRole: context.agentRole,
					taskType: context.taskType ?? '',
					taskId: context.taskId ?? '',
					inputTokens: 0,
					outputTokens: 0,
					cachedTokens: 0,
					cacheCreationTokens: 0,
					latencyMs: errLatencyMs,
					cost: 0,
					success: false,
					error: lastError.message,
				});
				const errLabels = { provider, model, agent_role: context.agentRole, outcome: 'error' };
				llmRequestTotal.inc(errLabels);
				llmRequestDuration.observe(errLatencyMs, errLabels);
				// Network / connection error — try next provider
			}
		}

		// All providers exhausted — attribute the failure to the last attempted provider.
		const latencyMs = Date.now() - startTime;
		console.error('All providers failed. Last error:', lastError?.message);

		metrics.record({
			id: randomUUID(),
			timestamp: Date.now(),
			provider: lastProvider,
			model: lastModel,
			agentRole: context.agentRole,
			taskType: context.taskType ?? '',
			taskId: context.taskId ?? '',
			inputTokens: 0,
			outputTokens: 0,
			cachedTokens: 0,
			cacheCreationTokens: 0,
			latencyMs,
			cost: 0,
			success: false,
			error: lastError?.message,
		});

		const exhaustedLabels = { provider: lastProvider, model: lastModel, agent_role: context.agentRole, outcome: 'all_failed' };
		llmRequestTotal.inc(exhaustedLabels);
		llmRequestDuration.observe(latencyMs, exhaustedLabels);

		res.status(502).json({ error: lastError?.message ?? 'All providers failed' });
	});

	// Prometheus metrics endpoint
	app.get('/metrics', prometheusHandler() as any);

	// Legacy JSON metrics (kept for backward compat with existing tooling)
	app.get('/metrics/json', (_req, res) => {
		res.json(metrics.getAggregated());
	});

	app.get('/metrics/recent', (req, res) => {
		const count = parseInt(req.query.count as string, 10) || 10;
		res.json(metrics.getRecent(count));
	});

	// Config reload
	app.post('/config/reload', (_req, res) => {
		try {
			const newConfig = loadConfig();
			router.reloadConfig(newConfig);
			failoverConfig = loadFailoverConfig();
			res.json({ status: 'reloaded' });
		} catch (err) {
			res.status(500).json({ error: (err as Error).message });
		}
	});

	return app;
}
