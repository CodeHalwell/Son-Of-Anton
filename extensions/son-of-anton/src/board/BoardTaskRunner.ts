/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as vscode from 'vscode';
import type { AgentBridge } from '../chat/AgentBridge';
import type { ModelId } from 'son-of-anton-core/llm/LlmClient';
import type { AgentHandle } from 'son-of-anton-core/agents/types';
import type { TaskBoardModel } from './TaskBoardModel';

/** Execute a saved board task even after its original plan has settled. */
export class BoardTaskRunner {
	private readonly running = new Set<string>();
	constructor(private readonly board: TaskBoardModel, private readonly bridge: AgentBridge) { }

	async run(conversationId: string, taskId: string, token: vscode.CancellationToken, model?: ModelId): Promise<void> {
		const key = `${conversationId}:${taskId}`;
		const snapshot = this.board.getSnapshot(conversationId);
		const task = snapshot?.tasks.find(task => task.id === taskId);
		if (!task) { throw new Error(vscode.l10n.t('This task is no longer available. Refresh the board.')); }
		if (this.running.has(key) || task.state === 'in-progress' || task.state === 'review') { return; }
		if (task.dependencies.some(id => snapshot?.tasks.find(dependency => dependency.id === id)?.state !== 'done')) {
			throw new Error(vscode.l10n.t('Complete this task’s dependencies before running it.'));
		}
		if (token.isCancellationRequested) { return; }
		this.running.add(key);
		this.board.updateTask(conversationId, taskId, { state: 'in-progress', startedAt: Date.now(), finishedAt: undefined, summary: undefined });
		try {
			let result: string | undefined;
			let error: string | undefined;
			const failedTools = new Map<string, string>();
			const prompt = [task.instruction, task.scopeFiles.length ? `Task scope: ${task.scopeFiles.join(', ')}` : '', ...task.dependencies.map(id => {
				const dependency = snapshot!.tasks.find(task => task.id === id)!;
				return `Completed dependency ${id}: ${dependency.summary || dependency.instruction}`;
			})].filter(Boolean).join('\n\n');
			await this.bridge.runSpecialist(task.assignee as AgentHandle, prompt, event => {
				if (event.type === 'final') { result = event.text; }
				if (event.type === 'error') { error = event.message; }
				if (event.type === 'tool-call' && event.status === 'error') { failedTools.set(event.name, event.output || event.name); }
				if (event.type === 'tool-call' && event.status === 'done') { failedTools.delete(event.name); }
			}, token, model, undefined, conversationId);
			if (token.isCancellationRequested) { throw new Error(vscode.l10n.t('Task cancelled. You can retry it.')); }
			if (failedTools.size) { throw new Error(vscode.l10n.t('Task needs attention: {0}', [...failedTools.values()].join('\n'))); }
			if (error || result === undefined) { throw new Error(error || vscode.l10n.t('The agent stopped without a result.')); }
			this.board.updateTask(conversationId, taskId, { state: 'done', summary: result, finishedAt: Date.now() });
		} catch (error) {
			this.board.updateTask(conversationId, taskId, { state: 'failed', summary: error instanceof Error ? error.message : String(error), finishedAt: Date.now() });
			throw error;
		} finally { this.running.delete(key); }
	}
}
