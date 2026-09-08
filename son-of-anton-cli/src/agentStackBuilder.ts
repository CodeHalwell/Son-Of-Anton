/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { AgentManager } from 'son-of-anton-core/dist/agents/AgentManager';
import { createAgentStack, type AgentStack } from 'son-of-anton-core/dist/agents/AgentStackFactory';
import { SessionBudget } from 'son-of-anton-core/dist/agents/SessionBudget';
import type { CoreHost, Disposable } from 'son-of-anton-core/dist/host';
import { LlmClient } from 'son-of-anton-core/dist/llm/LlmClient';
import { getSystemCatalog } from 'son-of-anton-core/dist/integrations/SystemCatalog';
import { McpClient, type McpClientDeps } from 'son-of-anton-core/dist/mcp/McpClient';
import type { ApprovalGate } from './approval';
import { HookRunner, hooksFilePath } from './persistence/HookRunner';
import { instrumentToolExecutionContext } from './persistence/instrumentToolExecutionContext';
import { buildCliToolExecutionContext } from './toolExecutionContext';

/**
 * Optional wiring for {@link buildCliAgentStack}. Callers that drive
 * side-effecting agentic runs pass an {@link ApprovalGate} so tool execution
 * prompts before writes, commands and external MCP calls. ACP sessions route
 * these decisions back to their client through session/request_permission.
 */
export interface CliAgentStackOptions {
	readonly approvalGate?: ApprovalGate;
	/** ACP server sessions must not recursively route back into external agents. */
	readonly disableAcpRouting?: boolean;
}

/**
 * Build the session spend kill switch from opt-in environment variables so
 * headless `sota run` loops honour a cost / token / request cap. Off by
 * default: with none of the vars set the run stays uncapped (the historical
 * behaviour). Only positive, finite values are applied.
 */
function buildCliSpendGuard(): SessionBudget | undefined {
	const num = (raw: string | undefined): number | undefined => {
		if (raw === undefined || raw.trim() === '') {
			return undefined;
		}
		const value = Number(raw);
		return Number.isFinite(value) && value > 0 ? value : undefined;
	};
	const maxCostUsd = num(process.env.SOTA_SESSION_MAX_COST_USD);
	const maxTotalTokens = num(process.env.SOTA_SESSION_MAX_TOKENS);
	const maxRequests = num(process.env.SOTA_SESSION_MAX_REQUESTS);
	if (maxCostUsd === undefined && maxTotalTokens === undefined && maxRequests === undefined) {
		return undefined;
	}
	return new SessionBudget({
		...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
		...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
		...(maxRequests !== undefined ? { maxRequests } : {}),
	});
}

/**
 * Construct the canonical agent stack for the CLI. Mirrors the extension's
 * activation wiring (`extensions/son-of-anton/src/extension.ts`) but uses the
 * file-backed CoreHost from `cliHost.ts`. Trusted workspaces can use MCP
 * servers from host configuration, including ACP session/new descriptors.
 */
export function buildCliAgentStack(host: CoreHost, options?: CliAgentStackOptions): { stack: AgentStack; llm: LlmClient; agentManager: AgentManager; mcpClient: McpClient; hookRunner?: HookRunner; dispose: () => void } {
	const llm = new LlmClient(host.secrets, host.config);

	// Configuration is fixed for this CLI invocation or ACP session.
	const mcpDeps: McpClientDeps = {
		readServersSetting: async () => {
			if (!host.workspace.isTrusted) { return []; }
			const configured = host.config.get<unknown>('sota.mcp.servers');
			const list = Array.isArray(configured) ? configured : [];
			if (host.config.get('sota.integrations.enabled') === false) { return list; }
			const catalog = await getSystemCatalog({ workspace: host.workspace.folders[0]?.fsPath });
			const selected = host.config.get<unknown>('sota.integrations.mcpServers');
			return [...list, ...(Array.isArray(selected) ? selected.flatMap(id => typeof id === 'string' && catalog.servers.has(id) ? [catalog.servers.get(id)!] : []) : [])];
		},
		getWorkspaceRoot: () => host.workspace.folders[0]?.fsPath,
		onSettingChange: (_listener) => ({ dispose: () => { /* no-op */ } } as Disposable),
	};
	const mcpClient = new McpClient(mcpDeps);

	const agentManager = new AgentManager(llm);
	// Construct a real ToolExecutionContext when a workspace root is known so
	// CodeGeneratorAgent's H1 native tool-use loop fires. CLI invocations
	// without a workspace (rare — mostly happens in tests) skip the context
	// and fall back to the legacy diff-parse path.
	const workspaceRoot = host.workspace.folders[0]?.fsPath;
	const baseToolExecutionContext = workspaceRoot ? buildCliToolExecutionContext(workspaceRoot, host, options?.approvalGate) : undefined;
	// Wrap the tool execution context with the hooks runtime when the workspace
	// is trusted AND `.son-of-anton/hooks.json` exists. We skip instantiation
	// (rather than relying solely on the runner's no-op behaviour for empty
	// configs) so untrusted or hook-less workspaces pay zero overhead.
	const hookRunner = workspaceRoot && host.workspace.isTrusted && fs.existsSync(hooksFilePath(workspaceRoot))
		? new HookRunner(host)
		: undefined;
	const toolExecutionContext = baseToolExecutionContext && hookRunner
		? instrumentToolExecutionContext(baseToolExecutionContext, hookRunner)
		: baseToolExecutionContext;
	// `configStore` lets the factory read per-agent model overrides at
	// construction (`sota.agents.<handle>.model` settings in
	// `~/.son-of-anton/config.json`). The CLI process is short-lived so
	// any setting change is picked up on the next `sota` invocation
	// without reload churn.
	const stack = createAgentStack({
		canUseAcp: () => host.workspace.isTrusted,
		acpPermission: async (request, signal) => {
			if (signal.aborted || !options?.approvalGate) { return { outcome: { outcome: 'cancelled' } }; }
			const decision = await options.approvalGate({ kind: request.toolCall.kind === 'edit' ? 'write' : 'command', detail: JSON.stringify(request.toolCall).slice(0, 8000) });
			const selected = request.options.find(option => option.kind === (decision.approved ? 'allow_once' : 'reject_once'));
			return signal.aborted || !selected ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: selected.optionId } };
		},
		llmClient: llm,
		mcpClient,
		agentManager,
		globalState: host.globalState,
		workspaceRoot,
		projectContext: host.projectContext,
		toolExecutionContext: toolExecutionContext ? {
			...toolExecutionContext,
			requestMcpApproval: async (tool, input, signal) => {
				if (signal?.aborted || !host.workspace.isTrusted || !options?.approvalGate) { return false; }
				const decision = await options.approvalGate({ kind: 'command', detail: `MCP ${tool.name}: ${JSON.stringify(input).slice(0, 8000)}` });
				return !signal?.aborted && decision.approved;
			},
		} : undefined,
		configStore: options?.disableAcpRouting ? { ...host.config, get: <T>(key: string) => key.endsWith('.acpAgent') ? undefined : host.config.get<T>(key) } : host.config,
		spendGuard: buildCliSpendGuard(),
	});

	const dispose = (): void => {
		try { stack.dispose(); } catch { /* swallow on shutdown */ }
		try { mcpClient.dispose(); } catch { /* swallow on shutdown */ }
	};

	return { stack, llm, agentManager, mcpClient, hookRunner, dispose };
}
