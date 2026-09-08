/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { TaskBoardPanel } from '../src/board/TaskBoardPanel';
import { ProposalReviewPanel } from '../src/council/ProposalReviewPanel';
import { CouncilController } from '../src/council/CouncilController';

suite('Review execution and evidence boundaries', () => {
	const warning = vscode.window.showWarningMessage;
	const showDocument = vscode.window.showTextDocument;
	const documents = Object.getOwnPropertyDescriptor(vscode.workspace, 'textDocuments');
	teardown(() => {
		vscode.window.showWarningMessage = warning; vscode.window.showTextDocument = showDocument;
		if (documents) { Object.defineProperty(vscode.workspace, 'textDocuments', documents); }
	});
	for (const state of ['done', 'failed']) {
		for (const approve of [false, true]) {
			test(`${state} rerun requires native confirmation (${approve ? 'approve' : 'cancel'})`, async () => {
				const reruns: string[] = [];
				vscode.window.showWarningMessage = (async (...args: object[]) => approve ? args.at(-1) : undefined) as typeof vscode.window.showWarningMessage;
				const panel = Object.assign(Object.create(TaskBoardPanel.prototype), { currentConversationId: 'conversation', pendingReruns: new Set(), closed: false, model: { getSnapshot: () => ({ tasks: [{ id: 'task', state, instruction: 'Run fixture' }] }) }, handlers: { rerunSubtask: (id: string) => reruns.push(id) } }) as { confirmRerun(id: string): Promise<void> };
				await panel.confirmRerun('task');
				assert.deepEqual(reruns, approve ? ['task'] : []);
			});
		}
	}
	test('duplicate rerun requests share one prompt and a changed task cannot start', async () => {
		let answer!: (value: string) => void; let prompts = 0, reruns = 0;
		vscode.window.showWarningMessage = (() => { prompts++; return new Promise<string>(resolve => { answer = resolve; }); }) as typeof vscode.window.showWarningMessage;
		const task = { id: 'task', state: 'done', instruction: 'Fixture' };
		const panel = Object.assign(Object.create(TaskBoardPanel.prototype), { currentConversationId: 'conversation', pendingReruns: new Set(), closed: false, model: { getSnapshot: () => ({ tasks: [task] }) }, handlers: { rerunSubtask: () => reruns++ } }) as { confirmRerun(id: string): Promise<void> };
		const pending = panel.confirmRerun('task'); await panel.confirmRerun('task');
		task.state = 'in-progress'; answer('Run Again'); await pending;
		assert.deepEqual({ prompts, reruns }, { prompts: 1, reruns: 0 });
	});
	test('dirty dot-dot-prefixed workspace directories block proposal writes', () => {
		const root = path.resolve('review-workspace');
		const panel = Object.assign(Object.create(ProposalReviewPanel.prototype), { displayWorkspace: root }) as { checkBuffers(): void };
		for (const [relative, blocked] of [['..generated/file.ts', true], ['.../file.ts', true], ['src/file.ts', true], ['../outside/file.ts', false]] as const) {
			Object.defineProperty(vscode.workspace, 'textDocuments', { configurable: true, value: [{ isDirty: true, uri: vscode.Uri.file(path.resolve(root, relative)) }] });
			if (blocked) { assert.throws(() => panel.checkBuffers(), /Save workspace editor buffers/); }
			else { assert.doesNotThrow(() => panel.checkBuffers()); }
		}
	});
	test('Council evidence opens the retained patch even when the reviewed file no longer exists', async () => {
		const root = path.resolve('removed-review-workspace');
		const patch = 'diff --git a/deleted.ts b/deleted.ts\ndeleted file mode 100644\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const value = 1;\n';
		const report = { snapshot: { workspace: root, files: ['deleted.ts'], patch }, id: 'report', stages: [{ id: 'stage', answer: { findings: [{ file: 'deleted.ts', line: 1 }] } }] };
		let opened: vscode.Uri | undefined;
		vscode.window.showTextDocument = (async (uri: vscode.Uri) => { opened = uri; return {}; }) as typeof vscode.window.showTextDocument;
		const controller = Object.assign(Object.create(CouncilController.prototype), { ready: Promise.resolve(), workspace: root, evidenceScheme: 'sota-test-evidence', service: { store: { load: async () => report } } }) as { handle(message: { type: string; id: string; stageId: string; index: number }): Promise<void>; evidenceContent(uri: vscode.Uri): Promise<string> };
		await controller.handle({ type: 'evidence', id: 'report', stageId: 'stage', index: 0 });
		assert.deepEqual({ scheme: opened?.scheme, content: await controller.evidenceContent(opened!) }, { scheme: 'sota-test-evidence', content: patch });
		report.snapshot.files = [];
		await assert.rejects(controller.handle({ type: 'evidence', id: 'report', stageId: 'stage', index: 0 }), /Finding unavailable/);
	});
});
