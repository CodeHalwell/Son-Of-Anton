/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { BaseAgent } from './BaseAgent';
import { AgentManager } from './AgentManager';
import { MetricsTracker } from './MetricsTracker';
import { ProjectMemory } from './ProjectMemory';
import { McpClient } from '../mcp/McpClient';
import { LlmClient } from '../llm/LlmClient';
import { GitSnapshotStore } from '../checkpoint/GitSnapshotStore';

class WorkflowAgent extends BaseAgent {
	protected getRoleDescription(): string { return 'Offline edit fixture'; }
	async execute(): Promise<never> { throw new Error('Use drive'); }
	drive(execute: (input: Record<string, unknown>) => Promise<void>) {
		return this.runToolLoop({ taskId: 'workflow-v1', model: 'gpt-4o', systemPrompt: 'Fix the fixture with edit_fixture.', initialMessages: [{ role: 'user', content: 'Fix the addition bug' }], tools: [{ name: 'edit_fixture', description: 'Edit the fixture after approval', inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } }], maxIterations: 3, executeTool: async call => { await execute(call.input); return { result: 'Saved' }; } });
	}
}

test('offline workflow: proposal, approval, edit, diff, restart and checkpoint recovery', { timeout: 20000 }, async t => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'sota-workflow-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
	const original = 'module.exports = (a, b) => a - b;\n';
	const corrected = 'module.exports = (a, b) => a + b;\n';
	await writeFile(path.join(root, 'sum.cjs'), original);
	git('add', '.'); git('commit', '-qm', 'fixture');
	const snapshot = JSON.parse(JSON.stringify(await new GitSnapshotStore(root).capture()));
	let requestCount = 0;
	t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body));
		requestCount++;
		if (requestCount === 2) { assert.equal(body.messages.at(-1).content, 'Saved'); }
		const frame = { choices: [{ delta: requestCount === 1 ? { tool_calls: [{ index: 0, id: 'edit-1', function: { name: 'edit_fixture', arguments: JSON.stringify({ content: corrected }) } }] } : { content: 'Fixed and saved.' }, finish_reason: requestCount === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } };
		return new Response('data: ' + JSON.stringify(frame) + '\n\n');
	});
	const llm = new LlmClient({ get: async () => 'synthetic', store: async () => {}, delete: async () => {} }, { get: <T>(_key: string, fallback?: T) => fallback as T });
	const mcp = new McpClient({ readServersSetting: () => [], getWorkspaceRoot: () => root, onSettingChange: () => ({ dispose() {} }) });
	t.after(() => mcp.dispose());
	const agent = new WorkflowAgent({ handle: 'anton-code', displayName: 'Fixture', description: 'Fixture', defaultModel: 'gpt-4o', maxRetries: 0, slashCommands: [] }, llm, mcp, new AgentManager(llm), new MetricsTracker(), new ProjectMemory());
	let proposed!: () => void;
	let approve!: () => void;
	const proposal = new Promise<void>(resolve => { proposed = resolve; });
	const approval = new Promise<void>(resolve => { approve = resolve; });
	const run = agent.drive(async input => {
		proposed();
		await approval;
		assert.equal(typeof input.content, 'string');
		await writeFile(path.join(root, 'sum.cjs'), input.content as string);
	});
	await proposal;
	assert.equal(await readFile(path.join(root, 'sum.cjs'), 'utf8'), original);
	approve();
	const result = await run;
	assert.equal(result.text, 'Fixed and saved.');
	assert.equal(execFileSync(process.execPath, ['-e', "if (require('./sum.cjs')(2,3) !== 5) process.exit(1)"], { cwd: root }).length, 0);
	assert.deepEqual(git('diff', '--name-only'), 'sum.cjs');
	const restarted = new GitSnapshotStore(root);
	const recovery = await restarted.restore(snapshot, async files => { assert.deepEqual(files, ['sum.cjs']); return true; });
	assert.equal(git('status', '--porcelain'), '');
	assert.equal(await readFile(path.join(root, 'sum.cjs'), 'utf8'), original);
	assert.ok(recovery);
	await new GitSnapshotStore(root).restore(recovery, async () => true);
	assert.equal(await readFile(path.join(root, 'sum.cjs'), 'utf8'), corrected);
	if (process.env.SOTA_TASK_EVAL_OUTPUT) { await writeFile(process.env.SOTA_TASK_EVAL_OUTPUT, JSON.stringify({ fixture: 'workflow-v1', provider: 'deterministic-offline', completed: 1, unrelatedEdits: 0, approvalRequired: true, recoveryPassed: true, inputTokens: result.tokenUsage.inputTokens, outputTokens: result.tokenUsage.outputTokens }, null, 2) + '\n'); }
});
