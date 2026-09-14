// Copyright (c) Son-Of-Anton. All rights reserved.
// Licensed under the MIT License.

import express from 'express';
import rateLimit from 'express-rate-limit';
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
import { createAuthMiddleware } from '../_shared/auth/dist/index.js';
import type { UsageObserver } from './providers/types.js';
import { passthroughCollectUsage } from './streamingMetrics.js';
import { writeResponse } from './responseWriter.js';
import { createProviderRegistry } from './providers/registry.js';
import { FailoverChain } from './failover/failoverChain.js';
import type { BrokerLike } from './providers/anthropic-oauth.js';
import { normalizeMessages, normalizeTools } from './messageContract.js';

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
	return router.resolveFallbackChain(context).map(target => ({ ...target, config: router.resolveProvider(target.provider) }));
}

function buildRequestHeaders(config: ProviderConfig): Record<string, string> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (config.format === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; }
	if (config.apiKey) {
		if (config.format === 'anthropic') {
			headers['x-api-key'] = config.apiKey;
		} else {
			headers['Authorization'] = `Bearer ${config.apiKey}`;
		}
	}
	return headers;
}

function buildEndpoint(config: ProviderConfig): string {
	const baseUrl = config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
	return config.format === 'anthropic'
		? `${baseUrl}/v1/messages`
		: `${baseUrl}/v1/chat/completions`;
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

export function createServer(options: { config?: ModelRoutesConfig; failover?: FailoverConfig; broker?: BrokerLike; timeoutMs?: number } = {}) {
	const config = options.config ?? loadConfig();
	let failoverConfig = options.failover ?? loadFailoverConfig();
	const router = new ModelRouter(config);
	const metrics = new MetricsCollector();
	const adapterFor = createProviderRegistry(router, options.broker);
	const app = express();

	app.use(express.json({ limit: '10mb' }));
	app.use(expressTracingMiddleware('model-router'));
	app.use(expressMetricsMiddleware('model-router'));
	// Throttle inter-service traffic; health and metrics probes are exempt.
	app.use(rateLimit({
		windowMs: 60_000,
		max: 1000,
		standardHeaders: true,
		legacyHeaders: false,
		skip: (req) => req.path === '/health' || req.path === '/metrics',
	}));
	// Enforce inter-service auth (exempts /health and /metrics).
	app.use(createAuthMiddleware());

	// Health endpoint
	app.get('/health', (_req, res) => {
		res.json({ status: 'ok', service: 'model-router' });
	});

	app.get('/ready', async (_req, res) => {
		const ids = new Set(Object.keys(router.getConfig().providers));
		for (const role of Object.values(failoverConfig)) { for (const target of [role.primary, ...(role.fallback ?? [])]) { if (target) { ids.add(target.provider); } } }
		const providers = await Promise.all([...ids].map(async id => {
			try { return { id, configured: await adapterFor(id).isAvailable() }; }
			catch { return { id, configured: false }; }
		}));
		const ready = providers.some(provider => provider.configured);
		res.status(ready ? 200 : 503).json({ status: ready ? 'configured' : 'unconfigured', providers, liveConnectivityChecked: false });
	});

	// Main routing endpoint retains its existing provider SSE wire format.
	const handleMessages: express.RequestHandler = async (req, res) => {
		const normalizedStream = req.path === '/v1/agent-events';
		if (normalizedStream && req.body?.stream !== true) { res.status(400).json({ error: '/v1/agent-events requires stream: true' }); return; }
		const context: RoutingContext = { agentRole: req.get('x-agent-role') ?? 'default', taskType: req.get('x-task-type'), taskId: req.get('x-task-id') };
		const traceCtx = extractOrCreateTraceContext(req);
		const isStreaming = req.body?.stream === true;
		const messages = req.body?.messages;
		const maxTokens = req.body?.max_tokens ?? 4096;
		if (!Array.isArray(messages) || !messages.length || !messages.every(message => message && typeof message.role === 'string' && (typeof message.content === 'string' || Array.isArray(message.content) || (message.content === null && Array.isArray(message.tool_calls)))) || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1_000_000 || (req.body.system !== undefined && typeof req.body.system !== 'string')) {
			res.status(400).json({ error: 'Expected messages and a positive integer max_tokens (at most 1000000).' });
			return;
		}
		let tools;
		try { normalizeMessages(messages); tools = normalizeTools(req.body.tools); }
		catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid request' }); return; }
		const startTime = Date.now();
		const requestId = randomUUID();
		const reqAbort = new AbortController();
		let timedOut = false;
		const configuredTimeout = Number(options.timeoutMs ?? process.env.MODEL_ROUTER_TIMEOUT_MS ?? 120000);
		const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(10, Math.min(configuredTimeout, 600000)) : 120000;
		const timer = setTimeout(() => { timedOut = true; reqAbort.abort(); }, timeoutMs);
		const close = (): void => { if (!res.writableEnded) { reqAbort.abort(); } };
		res.once('close', close);
		let lastError: Error | undefined;
		let provider = 'unresolved';
		let model = 'unresolved';
		let inputIncludesCache = true;
		let success = false;
		let outcome = 'error';
		let usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
		try {
			if (normalizedStream) {
				const role = failoverConfig[context.agentRole] ?? failoverConfig['*'];
				const targets = role?.primary ? [role.primary, ...(role.fallback ?? [])] : router.resolveFallbackChain(context);
				const chain = new FailoverChain(targets.map(target => ({ model: target.model, adapter: adapterFor(target.provider) })));
				res.setHeader('Content-Type', 'text/event-stream');
				res.setHeader('Cache-Control', 'no-cache');
				res.setHeader('X-Accel-Buffering', 'no');
				let stopped = false;
				for await (const event of chain.send({ requestId, model: targets[0].model, messages: normalizeMessages(messages), system: req.body.system, maxTokens, tools, agentRole: context.agentRole }, reqAbort.signal)) {
					if (event.type === 'message_start') { provider = event.provider; model = event.model; inputIncludesCache = provider !== 'anthropic-oauth' && router.getConfig().providers[provider]?.format !== 'anthropic'; }
					if (event.type === 'usage') {
						usage.inputTokens = Math.max(usage.inputTokens, event.inputTokens);
						usage.outputTokens = Math.max(usage.outputTokens, event.outputTokens);
						usage.cacheReadInputTokens = Math.max(usage.cacheReadInputTokens, event.cacheReadInputTokens ?? 0);
						usage.cacheCreationInputTokens = Math.max(usage.cacheCreationInputTokens, event.cacheCreationInputTokens ?? 0);
					}
					if (event.type === 'error') { lastError = new Error(event.message); }
					if (event.type === 'message_stop') { stopped = true; if (event.stopReason === 'error' && !lastError) { lastError = new Error('Provider stream failed'); } }
					await writeResponse(res, 'data: ' + JSON.stringify(event) + '\n\n', reqAbort.signal);
				}
				reqAbort.signal.throwIfAborted();
				success = stopped && !lastError;
				outcome = success ? 'success' : 'error';
				res.end();
				return;
			}

			const candidates = resolveProvidersForRole(context.agentRole, context, router, failoverConfig);
			for (const candidate of candidates) {
				provider = candidate.provider;
				model = candidate.model;
				const providerConfig = candidate.config;
				inputIncludesCache = providerConfig.format !== 'anthropic';
				try {
					reqAbort.signal.throwIfAborted();
					const body = providerConfig.format === 'anthropic'
						? toAnthropicFormat(messages, req.body.system, maxTokens, model, isStreaming, tools)
						: toOpenAIFormat(messages, req.body.system, maxTokens, model, isStreaming, tools);
					const response = await fetch(buildEndpoint(providerConfig), { method: 'POST', headers: addTraceHeaders(buildRequestHeaders(providerConfig), traceCtx), body: JSON.stringify(body), signal: reqAbort.signal });
					if (!response.ok) {
						await response.body?.cancel();
						lastError = new Error('Provider ' + provider + ' returned HTTP ' + response.status);
						if (response.status === 429 || response.status >= 500) { continue; }
						break;
					}
					if (isStreaming) {
						if (!response.body) { throw new Error('Provider returned no response stream'); }
						res.setHeader('Content-Type', 'text/event-stream');
						res.setHeader('Cache-Control', 'no-cache');
						res.setHeader('X-Accel-Buffering', 'no');
						const reader = response.body.getReader();
						async function* chunks(): AsyncIterable<Buffer> {
							try {
								while (true) { const chunk = await reader.read(); if (chunk.done) { break; } yield Buffer.from(chunk.value); }
							} finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
						}
						for await (const chunk of passthroughCollectUsage(chunks(), value => { usage = { ...value }; })) {
							await writeResponse(res, chunk, reqAbort.signal);
						}
						reqAbort.signal.throwIfAborted();
						res.end();
					} else {
						const raw = await response.json() as Record<string, unknown>;
						const unified = providerConfig.format === 'anthropic' ? fromAnthropicResponse(raw) : fromOpenAIResponse(raw);
						usage = { inputTokens: unified.inputTokens, outputTokens: unified.outputTokens, cacheReadInputTokens: unified.cachedTokens, cacheCreationInputTokens: unified.cacheCreationTokens };
						res.json(unified);
					}
					success = true;
					outcome = 'success';
					return;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error('Provider request failed');
					// Once bytes are visible, replay could duplicate text or tool actions.
					if (res.headersSent || reqAbort.signal.aborted || lastError.name === 'AbortError') { break; }
				}
			}
		} catch (error) { lastError = error instanceof Error ? error : new Error('Routing failed'); }
		finally {
			clearTimeout(timer);
			res.off('close', close);
			if (reqAbort.signal.aborted) { outcome = timedOut ? 'timeout' : 'cancelled'; }
			const latencyMs = Date.now() - startTime;
			metrics.record({ id: requestId, timestamp: Date.now(), provider, model, agentRole: context.agentRole, taskType: context.taskType ?? '', taskId: context.taskId ?? '', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: usage.cacheReadInputTokens, cacheCreationTokens: usage.cacheCreationInputTokens, latencyMs, cost: calculateCost(model, usage.inputTokens + (inputIncludesCache ? 0 : usage.cacheReadInputTokens + usage.cacheCreationInputTokens), usage.outputTokens, usage.cacheReadInputTokens, usage.cacheCreationInputTokens), success, error: success ? undefined : lastError?.message });
			const labels = { provider, model, agent_role: context.agentRole, outcome };
			llmRequestTotal.inc(labels);
			llmRequestDuration.observe(latencyMs, labels);
			createPrometheusUsageObserver().recordUsage({ provider, model, agentRole: context.agentRole, ...usage });
		}
		if (res.destroyed || res.writableEnded) { return; }
		const code = timedOut ? 'timeout' : lastError?.name === 'AbortError' ? 'cancelled' : 'provider_error';
		const message = timedOut ? 'Provider request timed out' : lastError?.message ?? 'All providers failed';
		if (res.headersSent) {
			res.end('data: ' + JSON.stringify({ type: 'error', code, message, retryable: false }) + '\n\ndata: ' + JSON.stringify({ type: 'message_stop', stopReason: 'error' }) + '\n\n');
		} else { res.status(timedOut ? 504 : 502).json({ error: message }); }
	};
	app.post('/v1/messages', handleMessages);
	app.post('/v1/agent-events', handleMessages);

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
