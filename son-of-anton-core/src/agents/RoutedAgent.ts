/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import type { ModelId } from '../llm/LlmClient';
import type { CancellationLike, ChatContextLike, ChatRequestLike, ChatStreamLike } from '../chatStream';
import { BaseAgent, type AgentContext, type ChatTurnOptions } from './BaseAgent';
import type { SubtaskResult } from './types';

/** Resolve execution transport per turn so subscription models never enter a host-tool text transport. */
export class RoutedAgent extends BaseAgent {
	constructor(private readonly native: BaseAgent, private readonly route: (model: ModelId) => BaseAgent | undefined, ...base: ConstructorParameters<typeof BaseAgent>) { super(...base); }
	protected getRoleDescription(): string { return this.native.getAcpInstructions(); }
	override getAcpInstructions(): string { return this.native.getAcpInstructions(); }
	override interpretAcpResult(result: SubtaskResult): SubtaskResult { return this.native.interpretAcpResult(result); }

	override async execute(context: AgentContext): Promise<SubtaskResult> {
		try { return await (this.route(this.resolveModel(context.orchestratorModelHint)) ?? this.native).execute(context); }
		catch (error) { return { success: false, changes: [], summary: error instanceof Error ? error.message : 'Specialist routing failed', tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, naiveInputTokens: 0, accounting: 'unavailable' } }; }
	}

	override async handleChatRequest(request: ChatRequestLike, context: ChatContextLike, stream: ChatStreamLike, cancellation: CancellationLike): Promise<void> {
		await (this.route(request.modelOverride ?? this.defaultModel) ?? this.native).handleChatRequest(request, context, stream, cancellation);
	}

	override async runChatTurn(text: string, emit: (token: string) => void, cancellation: CancellationLike, options?: ChatTurnOptions): Promise<string> {
		const agent = options?.forceSingleShot ? this.native : this.route(options?.modelOverride ?? this.defaultModel) ?? this.native;
		return agent.runChatTurn(text, emit, cancellation, options);
	}

	override async runAgenticTurn(text: string, emit: Parameters<BaseAgent['runAgenticTurn']>[1], cancellation: CancellationLike, options?: ChatTurnOptions): Promise<string> {
		const agent = options?.forceSingleShot ? this.native : this.route(options?.modelOverride ?? this.defaultModel) ?? this.native;
		return agent.runAgenticTurn(text, emit, cancellation, options);
	}
}
