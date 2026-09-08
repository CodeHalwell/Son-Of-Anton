/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as vscode from 'vscode';
import { ChatTurnQueue } from '../src/chat/ChatTurnQueue';
import { assembleTurnContext, type TurnContext } from '../src/chat/TurnContext';
import { ChatSession, type ChatMessage } from '../src/chat/ChatPanel';
import { registerResponseFeedback, type ResponseExecution } from '../src/chat/ResponseFeedback';
import type { ConversationStore } from '../src/chat/ConversationStore';
import type { AgentEvent } from '../src/chat/agentEvents';
import type { ModelId } from 'son-of-anton-core/llm/LlmClient';

type Draft = { images?: Array<{ mime: string; base64: string }>; type: string; id?: string; text?: string; conversationId?: string; contextSnapshotId?: string; attachments?: string[]; excludedContext?: string[]; queueAction?: 'pause' | 'resume' | 'edit' | 'remove' | 'up' | 'down'; messageIndex?: number; value?: string };
type Output = { type: string; [key: string]: unknown };
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
interface SessionHarness {
	setupMessageHandler(): void;
	handleSendMessage(message: Draft, fromQueue?: boolean): Promise<void>;
	switchConversation(id: string): void;
	clearConversation(): void;
	abortController?: AbortController;
	currentConversationId: string;
	conversation: ChatMessage[];
	followupQueue: ChatTurnQueue<Draft>;
	previewedContext?: { key: string; value: TurnContext };
	workspaceContext: { collect(): Promise<{ markdown: string; estimatedTokens: number }> };
	buildUserPrompt(text: string, attachments?: string[]): Promise<string>;
}
function fixture() {
	const outputs: Output[] = []; const conversations = new Map<string, ChatMessage[]>([['first', []], ['second', []]]);
	const sent: Array<{ prompt: string; context?: string }> = [];
	let receive!: (message: Draft) => Promise<void>;
	let run: (prompt: string, emit: (event: AgentEvent) => void) => Promise<void> = async (_prompt, emit) => { emit({ type: 'token', token: 'Response' }); };
	const store = {
		rememberActive() {},
		update: (id: string, messages: ChatMessage[]) => conversations.set(id, [...messages]),
		load: (id: string) => conversations.has(id) ? { summary: { id }, messages: conversations.get(id)! } : undefined,
		create: () => { conversations.set('fresh', []); return { summary: { id: 'fresh' }, messages: [] }; },
	};
	const session = Object.assign(Object.create(ChatSession.prototype), {
		currentConversationId: 'first', conversation: [], currentSpecialistId: 'anton', currentMode: 'act', currentModel: 'sonnet', currentTab: 'chat', turnsRun: 0,
		disposables: [], pendingApprovals: new Map(), emittedUiBlockIds: new Set(), pendingUiBlockResponses: new Set(), followupQueue: new ChatTurnQueue<Draft>(), contextPreviewSequence: 0,
		conversationStore: store, sessionTotalCost: 0, sessionTotalTokens: 0, sessionTurnCount: 0,
		postProviderCatalog() {}, postHistorySnapshot() {}, postBoardSnapshot() {}, postCheckpointsForCurrentConversation() {}, refreshConnectionState: async () => {},
		webview: { onDidReceiveMessage: (listener: typeof receive) => { receive = listener; return { dispose() {} }; }, postMessage: (message: Output) => { outputs.push(message); return Promise.resolve(true); } },
		llmClient: { getTokenUsage: () => ({ input: 10, output: 5, cached: 0 }), estimateCost: () => 0.01 },
		workspaceContext: { collect: async () => ({ markdown: 'workspace content', estimatedTokens: 4 }) },
		buildUserPrompt: async (_text: string, attachments?: string[]) => attachments?.map(id => `contents:${id}`).join('\n') ?? '',
		agentBridge: { hasAgent: () => true, runOrchestrator: async (prompt: string, emit: (event: AgentEvent) => void, _cancellation: vscode.CancellationToken, options: { workspaceContextSnapshot?: string }) => { sent.push({ prompt, context: options.workspaceContextSnapshot }); await run(prompt, emit); } },
	}) as SessionHarness;
	session.setupMessageHandler();
	return { session, outputs, conversations, sent, receive: (message: Draft) => receive(message), setRun: (handler: typeof run) => { run = handler; } };
}

suite('Chat workflow upgrades', () => {
	test('queued drafts are deep copied, independently ordered and paused per conversation', () => {
		const queue = new ChatTurnQueue<{ text: string; images: string[] }>(); const draft = { text: 'first', images: ['image'] };
		const first = queue.add('a', draft); const second = queue.add('a', { text: 'second', images: [] }); queue.add('b', { text: 'other', images: [] }); draft.images[0] = 'mutated';
		queue.move('a', second, -1); queue.pause('a'); assert.equal(queue.take('a'), undefined); queue.pause('a', false);
		assert.deepEqual([queue.take('a')?.text, queue.remove('a', first)?.images, queue.take('b')?.text], ['second', ['image'], 'other']);
	});

	test('accepted in-flight drafts can be recovered when users fill the freed waiting slot', () => {
		const queue = new ChatTurnQueue<string>(); for (let index = 0; index < 10; index++) { queue.add('a', `draft-${index}`); }
		const accepted = queue.take('a')!; queue.add('a', 'newest'); queue.requeue('a', accepted);
		assert.deepEqual({ next: queue.take('a'), remaining: queue.snapshot('a').entries.length }, { next: 'draft-0', remaining: 10 });
		assert.throws(() => queue.add('a', 'overflow'), /full/);
	});

	test('context exclusions skip resolution and the preview contains the actual attachment payload', async () => {
		let excludedRead = false;
		const context = await assembleTurnContext([
			{ id: 'workspace', label: 'Editor', resolve: async () => 'current file' },
			{ id: 'attachment:terminal', label: 'Terminal', resolve: async () => 'command failed' },
			{ id: 'secret', label: 'Excluded', resolve: async () => { excludedRead = true; return 'secret'; } },
		], ['secret']);
		assert.deepEqual({ workspace: context.workspaceMarkdown, attached: context.attachmentMarkdown, excludedRead, omitted: context.sections[2].excluded }, { workspace: 'current file', attached: 'command failed', excludedRead: false, omitted: true });
	});

	test('context assembly stays within its combined character budget', async () => {
		const context = await assembleTurnContext(Array.from({ length: 32 }, (_, index) => ({ id: String(index), label: String(index), resolve: async () => 'x'.repeat(60_000) })));
		assert.ok(context.sections.map(section => section.markdown).filter(Boolean).join('\n\n').length <= 120_000);
		assert.ok(context.sections.every(section => section.markdown.length <= 40_000));
		let reads = 0; await assert.rejects(assembleTurnContext(Array.from({ length: 33 }, (_, index) => ({ id: String(index), label: String(index), resolve: async () => { reads++; return 'text'; } }))), /at most 32/); assert.equal(reads, 0);
	});

	test('queue acceptance is scoped to the request and does not start a second active turn', async () => {
		const f = fixture(); const gate = deferred(); const started = deferred(); f.setRun(async () => { started.resolve(); await gate.promise; });
		const running = f.session.handleSendMessage({ type: 'sendMessage', text: 'running', conversationId: 'first' }); await started.promise;
		await f.receive({ type: 'queueMessage', id: 'request-1', text: 'next', conversationId: 'first' });
		await f.receive({ type: 'queueMessage', id: 'stale', text: 'wrong workspace', conversationId: 'second' });
		assert.deepEqual({ sent: f.sent.map(turn => turn.prompt), accepted: f.outputs.filter(message => message.type === 'queueAccepted').map(message => message.id), waiting: f.session.followupQueue.snapshot('first').entries.map(entry => entry.draft.text) }, { sent: ['running'], accepted: ['request-1'], waiting: ['next'] });
		f.session.followupQueue.pause('first'); gate.resolve(); await running;
	});

	test('provider failure pauses pending follow-ups until explicitly resumed', async () => {
		const f = fixture(); f.session.followupQueue.add('first', { type: 'sendMessage', text: 'later', conversationId: 'first' }); f.setRun(async (_prompt, emit) => emit({ type: 'error', message: 'provider offline' }));
		await f.session.handleSendMessage({ type: 'sendMessage', text: 'request', conversationId: 'first' });
		assert.deepEqual({ sent: f.sent.length, paused: f.session.followupQueue.snapshot('first').paused, remaining: f.session.followupQueue.snapshot('first').entries.length }, { sent: 1, paused: true, remaining: 1 });
	});

	test('a failed bridge response retains useful partial text without emitting successful completion', async () => {
		const f = fixture(); f.setRun(async (_prompt, emit) => { emit({ type: 'token', token: 'Useful partial investigation' }); emit({ type: 'error', message: 'Adapter disconnected' }); });
		await f.session.handleSendMessage({ type: 'sendMessage', text: 'Investigate', conversationId: 'first' });
		const response = f.conversations.get('first')?.at(-1);
		assert.deepEqual({ text: response?.content, outcome: response?.execution?.outcome, completed: f.outputs.some(message => message.type === 'messageComplete'), paused: f.session.followupQueue.snapshot('first').paused }, { text: 'Useful partial investigation', outcome: 'failed', completed: false, paused: true });
	});

	test('invalid images fail before context reads, persistence or agent dispatch', async () => {
		for (const images of [[{ mime: 'image/svg+xml', base64: 'YWJj' }], [{ mime: 'image/png', base64: 'not-valid%%%' }], Array.from({ length: 11 }, () => ({ mime: 'image/png', base64: 'YWJj' }))]) {
			const f = fixture(); let reads = 0; f.session.workspaceContext.collect = async () => { reads++; return { markdown: 'workspace', estimatedTokens: 1 }; };
			await f.session.handleSendMessage({ type: 'sendMessage', text: 'Image', conversationId: 'first', images });
			assert.deepEqual({ reads, messages: f.conversations.get('first'), sent: f.sent, failed: f.outputs.some(message => message.type === 'streamError') }, { reads: 0, messages: [], sent: [], failed: true });
		}
	});

	test('a queued draft cancelled during context resolution returns to its owning conversation', async () => {
		const f = fixture(); const context = deferred(); f.session.workspaceContext.collect = async () => { await context.promise; return { markdown: 'old workspace', estimatedTokens: 3 }; };
		const pending = f.session.handleSendMessage({ type: 'sendMessage', text: 'queued', conversationId: 'first' }, true);
		f.session.switchConversation('second'); context.resolve(); await pending;
		assert.deepEqual({ drafts: f.session.followupQueue.snapshot('first').entries.map(entry => entry.draft.text), paused: f.session.followupQueue.snapshot('first').paused, other: f.session.followupQueue.snapshot('second').entries, sent: f.sent }, { drafts: ['queued'], paused: true, other: [], sent: [] });
	});

	test('starting a new chat keeps the previous follow-up queue isolated', async () => {
		const f = fixture(); const context = deferred(); f.session.workspaceContext.collect = async () => { await context.promise; return { markdown: 'old', estimatedTokens: 1 }; };
		f.session.followupQueue.add('first', { type: 'sendMessage', text: 'later in first', conversationId: 'first' });
		const pending = f.session.handleSendMessage({ type: 'sendMessage', text: 'old accepted', conversationId: 'first' }, true);
		f.session.clearConversation(); context.resolve(); await pending;
		assert.deepEqual({ active: f.session.currentConversationId, fresh: f.session.followupQueue.snapshot('fresh').entries, old: f.session.followupQueue.snapshot('first').entries.map(entry => entry.draft.text), sent: f.sent }, { active: 'fresh', fresh: [], old: ['old accepted', 'later in first'], sent: [] });
	});

	test('interrupting pre-context queued work prioritises the redirect and supersedes the obsolete draft', async () => {
		const f = fixture(); const context = deferred(); let calls = 0;
		f.session.workspaceContext.collect = async () => { if (++calls === 1) { await context.promise; } return { markdown: 'workspace', estimatedTokens: 2 }; };
		const pending = f.session.handleSendMessage({ type: 'sendMessage', text: 'interrupted', conversationId: 'first' }, true);
		const release = deferred(); f.setRun(async prompt => { if (prompt === 'new direction') { await release.promise; } });
		await f.receive({ type: 'redirectMessage', id: 'redirect', text: 'new direction', conversationId: 'first' }); context.resolve(); await pending; await tick();
		assert.equal(f.sent[0]?.prompt, 'new direction');
		assert.deepEqual(f.session.followupQueue.snapshot('first').entries, []);
		f.session.followupQueue.pause('first'); release.resolve(); await tick();
	});

	test('a cancelled queued draft is retained even after a replacement manual turn persists', async () => {
		const f = fixture(); const context = deferred(); let calls = 0;
		f.session.workspaceContext.collect = async () => { if (++calls === 1) { await context.promise; } return { markdown: 'workspace', estimatedTokens: 2 }; };
		const queued = f.session.handleSendMessage({ type: 'sendMessage', text: 'old queued', conversationId: 'first' }, true);
		await f.session.handleSendMessage({ type: 'sendMessage', text: 'replacement', conversationId: 'first' }); context.resolve(); await queued;
		assert.deepEqual(f.session.followupQueue.snapshot('first').entries.map(entry => entry.draft.text), ['old queued']);
	});

	test('a redirect settled while away cannot supersede a later cancelled turn after switching back', async () => {
		const f = fixture(); const firstContext = deferred();
		f.session.workspaceContext.collect = async () => { await firstContext.promise; return { markdown: 'old workspace', estimatedTokens: 2 }; };
		const obsolete = f.session.handleSendMessage({ type: 'sendMessage', text: 'obsolete', conversationId: 'first' }, true);
		await f.receive({ type: 'redirectMessage', id: 'redirect', text: 'new direction', conversationId: 'first' });
		f.session.switchConversation('second'); firstContext.resolve(); await obsolete;
		f.session.switchConversation('first');
		const secondContext = deferred();
		f.session.workspaceContext.collect = async () => { await secondContext.promise; return { markdown: 'new workspace', estimatedTokens: 2 }; };
		const later = f.session.handleSendMessage({ type: 'sendMessage', text: 'later accepted', conversationId: 'first' }, true);
		f.session.abortController!.abort(); secondContext.resolve(); await later;
		assert.deepEqual({ waiting: f.session.followupQueue.snapshot('first').entries.map(entry => entry.draft.text), paused: f.session.followupQueue.snapshot('first').paused, sent: f.sent }, { waiting: ['later accepted', 'new direction'], paused: true, sent: [] });
	});

	test('context preview replies correlate to the latest same-conversation exclusion request', async () => {
		const f = fixture(); const oldContext = deferred<{ markdown: string; estimatedTokens: number }>();
		f.session.workspaceContext.collect = () => oldContext.promise;
		const old = f.receive({ type: 'previewWorkspaceContext', id: 'old-preview', conversationId: 'first' });
		await f.receive({ type: 'previewWorkspaceContext', id: 'new-preview', conversationId: 'first', excludedContext: ['workspace'] });
		oldContext.resolve({ markdown: 'excluded old content', estimatedTokens: 4 }); await old;
		assert.deepEqual(f.outputs.filter(message => message.type === 'workspaceContextPreview').map(message => ({ requestId: message.requestId, markdown: message.markdown })), [{ requestId: 'new-preview', markdown: '' }]);
		f.session.workspaceContext.collect = async () => { throw new Error('read failed'); };
		await f.receive({ type: 'previewWorkspaceContext', id: 'failed-preview', conversationId: 'first' });
		assert.equal(f.outputs.at(-1)?.requestId, 'failed-preview');
		assert.match(String(f.outputs.at(-1)?.error), /read failed/);
	});

	test('matching context preview is reused once and stale preview replies cannot replace a newer one', async () => {
		const f = fixture(); let contextReads = 0; f.session.workspaceContext.collect = async () => ({ markdown: `version-${++contextReads}`, estimatedTokens: 2 });
		await f.receive({ type: 'previewWorkspaceContext', conversationId: 'first', attachments: ['file'] });
		const preview = f.outputs.find(message => message.type === 'workspaceContextPreview')!;
		await f.session.handleSendMessage({ type: 'sendMessage', conversationId: 'first', text: 'use preview', attachments: ['file'], contextSnapshotId: preview.id as string });
		assert.deepEqual({ reads: contextReads, context: f.sent[0].context, prompt: f.sent[0].prompt }, { reads: 1, context: 'version-1', prompt: 'use preview\n\ncontents:file' });
		const slow = deferred<{ markdown: string; estimatedTokens: number }>(); f.session.workspaceContext.collect = () => slow.promise;
		const oldPreview = f.receive({ type: 'previewWorkspaceContext', conversationId: 'first' });
		f.session.switchConversation('second'); f.session.workspaceContext.collect = async () => ({ markdown: 'second context', estimatedTokens: 3 });
		await f.receive({ type: 'previewWorkspaceContext', conversationId: 'second' }); slow.resolve({ markdown: 'stale', estimatedTokens: 1 }); await oldPreview;
		assert.equal(f.session.previewedContext?.value.workspaceMarkdown, 'second context');
	});

	test('settling stale context collection does not erase the new conversation preview', async () => {
		const f = fixture(); const slow = deferred<{ markdown: string; estimatedTokens: number }>(); f.session.workspaceContext.collect = () => slow.promise;
		const old = f.session.handleSendMessage({ type: 'sendMessage', text: 'old', conversationId: 'first' });
		f.session.switchConversation('second'); f.session.workspaceContext.collect = async () => ({ markdown: 'reviewed second', estimatedTokens: 3 });
		await f.receive({ type: 'previewWorkspaceContext', conversationId: 'second' }); slow.resolve({ markdown: 'stale', estimatedTokens: 1 }); await old;
		assert.equal(f.session.previewedContext?.value.workspaceMarkdown, 'reviewed second');
	});

	test('response feedback ignores stale conversations and user messages', async () => {
		const f = fixture(); f.session.conversation.push({ role: 'user', content: 'Question', timestamp: 1 }, { role: 'assistant', content: 'Answer', timestamp: 2 });
		await f.receive({ type: 'feedback', conversationId: 'second', messageIndex: 1, value: 'down' });
		await f.receive({ type: 'feedback', conversationId: 'first', messageIndex: 0, value: 'up' });
		await f.receive({ type: 'feedback', conversationId: 'first', messageIndex: 1, value: 'up' });
		assert.deepEqual(f.session.conversation.map(message => message.feedback), [undefined, 'up']);
		await f.receive({ type: 'feedback', conversationId: 'first', messageIndex: 1, value: '' }); assert.equal(f.session.conversation[1].feedbackAt, undefined);
	});

	test('feedback export contains rated text and honest limits, excludes image bytes and unrated turns', async () => {
		let command!: () => Promise<void>; let content = ''; let opened = false;
		const originals = { register: vscode.commands.registerCommand, open: vscode.workspace.openTextDocument, show: vscode.window.showTextDocument };
		Object.assign(vscode.commands, { registerCommand: (_id: string, handler: typeof command) => { command = handler; return { dispose() {} }; } });
		Object.assign(vscode.workspace, { openTextDocument: async (options: { content: string }) => { content = options.content; return {}; } });
		Object.assign(vscode.window, { showTextDocument: async () => { opened = true; } });
		const messages: Array<ChatMessage & { execution?: ResponseExecution }> = [{ role: 'user', timestamp: 1, model: 'sonnet' as ModelId, content: [{ type: 'text', text: 'Question' }, { type: 'image', mimeType: 'image/png', base64Data: 'PRIVATE_IMAGE_BYTES' }] }, { role: 'assistant', timestamp: 2, content: 'Rated answer', feedback: 'down', feedbackAt: 3, usageUnavailable: true, execution: { route: 'acp', outcome: 'cancelled', latencyMs: 1200 } }, { role: 'assistant', timestamp: 4, content: 'Unrated' }];
		try {
			registerResponseFeedback({ subscriptions: [] } as unknown as vscode.ExtensionContext, { search: () => ({ items: [{ id: 'first', title: 'First', archived: true }, { id: 'trashed', title: 'Deleted', deletedAt: 1 }] }), load: (id: string) => { assert.equal(id, 'first'); return { messages }; } } as unknown as ConversationStore);
			await command(); const report = JSON.parse(content) as { summary: object; examples: Array<{ prompt: string; response: string; usageAvailable: boolean; archived: boolean }>; metrics: { estimatedCostUsd: number | null; meanLatencyMs: number | null }; outcomes: { cancelled: number }; limitations: string[] };
			assert.deepEqual({ opened, summary: report.summary, prompt: report.examples[0].prompt, response: report.examples[0].response, usage: report.examples[0].usageAvailable }, { opened: true, summary: { rated: 1, helpful: 0, notHelpful: 1 }, prompt: 'Question', response: 'Rated answer', usage: false });
			assert.deepEqual({ archived: report.examples[0].archived, latency: report.metrics.meanLatencyMs, cost: report.metrics.estimatedCostUsd, cancelled: report.outcomes.cancelled }, { archived: true, latency: 1200, cost: null, cancelled: 1 });
			assert.ok(!content.includes('PRIVATE_IMAGE_BYTES') && !content.includes('Unrated') && report.limitations.some(limit => limit.includes('not automated')));
		} finally { Object.assign(vscode.commands, { registerCommand: originals.register }); Object.assign(vscode.workspace, { openTextDocument: originals.open }); Object.assign(vscode.window, { showTextDocument: originals.show }); }
	});
});
