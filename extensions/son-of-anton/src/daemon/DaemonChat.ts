/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { NodeSession, type NodeSessionState, type NodeSessionOptions } from '@codypendent/protocol/node';
import type { QuestionOutcome, SessionEvent } from '@codypendent/protocol';
import type { ConversationStore } from '../chat/ConversationStore';

interface SessionLink { sessionId: string; repository: string; title: string; runtimeIdentity?: string }
export interface DaemonEndpoint { socketPath: string; identity: string; mode: 'local' | 'external' }

/** Resolve the endpoint from the runtime owner instead of inheriting SDK discovery defaults. */
export async function getDaemonEndpoint(): Promise<DaemonEndpoint> {
	const endpoint = await vscode.commands.executeCommand<DaemonEndpoint>('sota.daemon.endpoint');
	if (!endpoint || typeof endpoint.socketPath !== 'string' || !endpoint.socketPath || typeof endpoint.identity !== 'string' || !endpoint.identity
		|| !['local', 'external'].includes(endpoint.mode)) {
		throw new Error(vscode.l10n.t('The agent runtime endpoint is unavailable. Reload this window and try again.'));
	}
	return endpoint;
}
interface DaemonChatOptions {
	post(message: Record<string, unknown>): void;
	onState(state: NodeSessionState, conversationId: string): void;
	title(conversationId: string): string;
	onEvent?(event: SessionEvent): void;
	createSession?(options: NodeSessionOptions): NodeSession;
}
const sharedModelsChanged = new vscode.EventEmitter<void>();
export const onDidChangeSharedModels = sharedModelsChanged.event;

let context: vscode.ExtensionContext | undefined;
let configuredBackend: boolean | undefined;

export function configureDaemonChat(extensionContext: vscode.ExtensionContext): vscode.Disposable {
	context = extensionContext;
	configuredBackend = detectDaemonRuntime();
	return { dispose: () => { if (context === extensionContext) { context = undefined; configuredBackend = undefined; } } };
}

/** The contributed configuration supplies the production default; explicit native mode remains available for old sessions. */
export function usesDaemonRuntime(): boolean {
	return configuredBackend ?? detectDaemonRuntime();
}

function detectDaemonRuntime(): boolean {
	const backend = vscode.workspace.getConfiguration('sota').get<string>('runtime.backend');
	return backend === 'codypendent' || backend === 'auto' && process.platform !== 'win32';
}

export function hasSharedSession(conversationId: string): boolean {
	return context?.workspaceState.get<SessionLink>(`sota.daemon.session.${conversationId}`) !== undefined;
}

function workspaceId(repository: string): string {
	const bytes = createHash('sha256').update(`son-of-anton:${repository}`).digest().subarray(0, 16);
	bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
	const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Primary editor chat adapter. Only the daemon executes runs and owns their history. */
export class DaemonChat implements vscode.Disposable {
	private session?: NodeSession;
	private conversationId?: string;
	private link?: SessionLink;
	private connecting?: Promise<void>;
	private endpoint?: DaemonEndpoint;
	private selectionSequence = 0;
	private generation = 0;
	private publishTimer?: ReturnType<typeof setTimeout>;
	private boardTimer?: ReturnType<typeof setInterval>;
	private boardPendingFor?: NodeSession;
	private boardReadAfter = 0;
	private stopped = false;
	private pendingSubmission?: { cancelled: boolean };
	private waiters = new Set<() => void>();
	private readonly trustListener?: vscode.Disposable;
	constructor(private readonly options: DaemonChatOptions) {
		if (!context) { throw new Error(vscode.l10n.t('The shared runtime has not been initialized.')); }
		this.trustListener = vscode.workspace.onDidGrantWorkspaceTrust?.(() => {
			void this.reconnect().catch(error => this.post({ type: 'daemonStatus', error: String(error) }));
		});
	}

	get snapshot(): NodeSessionState | undefined { return this.session?.snapshot; }
	get sessionId(): string | undefined { return this.session?.snapshot.sessionId; }
	get runtimeIdentity(): string | undefined { return this.endpoint?.identity; }
	get isSubmitting(): boolean { return this.pendingSubmission !== undefined; }

	async select(conversationId: string): Promise<void> {
		const selection = ++this.selectionSequence;
		const endpoint = await getDaemonEndpoint();
		if (this.stopped || selection !== this.selectionSequence) { throw new Error(vscode.l10n.t('This connection was superseded.')); }
		if (this.conversationId === conversationId && this.endpoint?.identity === endpoint.identity && this.connecting) { return this.connecting; }
		const generation = ++this.generation;
		this.conversationId = conversationId; this.connecting = undefined;
		this.session?.disconnect(); clearTimeout(this.publishTimer); this.publishTimer = undefined;
		this.session = undefined; this.endpoint = endpoint;
		clearInterval(this.boardTimer); this.boardReadAfter = 0;
		this.wake();
		this.link = context!.workspaceState.get<SessionLink>(`sota.daemon.session.${conversationId}`);
		if (this.link && (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(this.link.sessionId) || typeof this.link.repository !== 'string' || !isAbsolute(this.link.repository))) { throw new Error(vscode.l10n.t('The shared session link is invalid.')); }
		if (this.link && (this.link.runtimeIdentity ? this.link.runtimeIdentity !== endpoint.identity : endpoint.mode !== 'external')) {
			throw new Error(vscode.l10n.t('This conversation belongs to a different agent runtime. Select its external connection to continue it, or start a new conversation. Its original history is retained.'));
		}
		const session = (this.options.createSession ?? (options => new NodeSession(options)))({
			socketPath: endpoint.socketPath,
			clientName: 'son-of-anton-chat', clientVersion: '0.1.0', canWrite: () => vscode.workspace.isTrusted,
			onEvent: event => { if (this.session === session && generation === this.generation) { this.options.onEvent?.(event); } },
			onChange: () => { if (this.session === session && generation === this.generation) { this.schedulePublish(); this.wake(); } },
			onError: error => { if (this.session === session && generation === this.generation) { this.post({ type: 'daemonStatus', error }); } },
		});
		this.session = session;
		this.boardTimer = setInterval(() => { void this.refreshBoard().catch(() => {}); }, 3000);
		const link = this.link;
		this.connecting = Promise.resolve(vscode.commands.executeCommand('sota.daemon.ensure', endpoint)).then(() => {
			if (this.session !== session || generation !== this.generation || this.stopped) { throw new Error(vscode.l10n.t('This connection was superseded.')); }
			return session.connect(link ? { session_id: link.sessionId, title: link.title,
				repository: link.repository, state: 'active', created_at: '', updated_at: '' } : undefined);
		})
			.then(async () => {
				if (this.session !== session || generation !== this.generation) { throw new Error(vscode.l10n.t('This connection was superseded.')); }
				if (link && !link.runtimeIdentity) {
					this.link = { ...link, runtimeIdentity: endpoint.identity };
					await context!.workspaceState.update(`sota.daemon.session.${conversationId}`, this.link);
					await context!.workspaceState.update(`sota.daemon.conversation.${endpoint.identity}.${link.sessionId}`, conversationId);
				}
				try { await this.refreshModels(); } catch (error) {
				if (this.session === session) { this.post({ type: 'daemonStatus', error: error instanceof Error ? error.message : String(error) }); }
			} }).catch(error => { if (this.session === session) { this.connecting = undefined; } throw error; });
		return this.connecting;
	}

	async reconnect(): Promise<void> {
		this.connecting = undefined;
		if (this.conversationId) { await this.select(this.conversationId); }
	}

	async send(conversationId: string, text: string, mode: 'Ask' | 'Explore' | 'Review' | 'Plan' | 'Build', model: string | undefined,
		requestId: string, signal: AbortSignal, accepted: (runId?: string) => void): Promise<void> {
		const pending = { cancelled: false }; this.pendingSubmission = pending;
		try { await this.submit(conversationId, text, mode, model, requestId, signal, accepted, pending); }
		finally { if (this.pendingSubmission === pending) { this.pendingSubmission = undefined; } }
	}

	private async submit(conversationId: string, text: string, mode: 'Ask' | 'Explore' | 'Review' | 'Plan' | 'Build', model: string | undefined,
		requestId: string, signal: AbortSignal, accepted: (runId?: string) => void, pending: { cancelled: boolean }): Promise<void> {
		if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before starting an agent run.')); }
		await this.select(conversationId);
		if (this.conversationId !== conversationId) { throw new Error(vscode.l10n.t('This chat request was superseded.')); }
		const session = this.session!; const generation = this.generation;
		this.assertCurrent(session, generation, signal);
		if (!this.link) {
			const folders = vscode.workspace.workspaceFolders ?? [];
			const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
			this.assertCurrent(session, generation, signal);
			if (!folder || folder.uri.scheme !== 'file') { throw new Error(vscode.l10n.t('Open and select a local repository before starting a run.')); }
			const repository = realpathSync(folder.uri.fsPath);
			const savedTitle = this.options.title(conversationId);
			const title = !savedTitle || ['New conversation', vscode.l10n.t('New conversation')].includes(savedTitle)
				? text.trim().split('\n')[0].slice(0, 80) : savedTitle;
			const id = await session.createSession(title, workspaceId(repository), repository,
				{ idempotencyKey: `anton-session:${createHash('sha256').update(`${repository}\0${conversationId}`).digest('hex')}` });
			this.assertCurrent(session, generation, signal);
			const endpoint = this.endpoint!;
			this.link = { sessionId: id, repository, title, runtimeIdentity: endpoint.identity };
			await context!.workspaceState.update(`sota.daemon.session.${conversationId}`, this.link);
			await context!.workspaceState.update(`sota.daemon.conversation.${endpoint.identity}.${id}`, conversationId);
		}
		this.assertCurrent(session, generation, signal);
		let selectedModel: string | undefined;
		if (model && model !== 'daemon:default') {
			if (!model.startsWith('daemon:')) { throw new Error(vscode.l10n.t('Choose a model from the shared runtime.')); }
			selectedModel = decodeURIComponent(model.slice(7));
			const models = await session.probeModels();
			if (!models.some(item => item.id === selectedModel)) { throw new Error(vscode.l10n.t('This model is no longer configured in the active agent runtime. Refresh the model list.')); }
		}
		const previous = [...session.snapshot.projection.activeRuns];
		const run = await session.submit(text, mode, { model: selectedModel, idempotencyKey: `anton-prompt:${this.link!.sessionId}:${requestId}` });
		this.assertCurrent(session, generation, signal);
		const runId = run ?? (previous.length === 1 ? previous[0] : undefined);
		if (!runId) { throw new Error(vscode.l10n.t('The daemon accepted this prompt without a run identity. Reconnect to reconcile its outcome before retrying.')); }
		accepted(runId);
		if (pending.cancelled && runId && !session.snapshot.projection.runs?.find(item => item.id === runId)?.disposition) {
			try { await session.cancelRun(runId); }
			catch (error) { if (!session.snapshot.projection.runs?.find(item => item.id === runId)?.disposition) { throw error; } }
		}
		if (runId) { await this.waitForRun(session, generation, runId, signal); }
	}

	async cancel(): Promise<void> {
		if (this.pendingSubmission) { this.pendingSubmission.cancelled = true; }
		const session = this.session;
		if (session) { await Promise.all(session.snapshot.projection.activeRuns.map(id => session.cancelRun(id))); }
	}

	async approve(id: string, approve: boolean): Promise<void> { await this.session?.resolveApproval(id, approve); }
	async answer(id: string, outcome: QuestionOutcome): Promise<void> { await this.session?.resolveQuestion(id, outcome); }

	async refreshModels(): Promise<void> {
		const session = this.session;
		if (!session) { return; }
		const models = await session.probeModels();
		if (this.session !== session) { return; }
		sharedModelsChanged.fire();
		this.post({ type: 'daemonRuntime', connected: true, sessionId: this.sessionId });
		const available = (item: typeof models[number]): boolean => ['ready', 'unverified'].includes(item.readiness.state);
		this.post({ type: 'providerCatalog', snapshot: { version: 1, updatedAt: Date.now(), software: [], providers: [{
			id: 'codypendent', name: this.endpoint?.mode === 'external' ? vscode.l10n.t('External Runtime') : vscode.l10n.t('Son of Anton'), catalogStatus: models.length ? 'ready' : 'not-configured', inferenceStatus: 'not-tested', credentialSource: 'daemon',
			models: [{ id: 'daemon:default', label: vscode.l10n.t('Automatic (Agent Runtime)'), chat: models.some(available), images: false },
				...models.map(item => ({ id: `daemon:${encodeURIComponent(item.id)}`, label: item.id, chat: available(item),
					images: false, tools: 'unknown', readiness: item.readiness }))],
		}] }, metadata: {} });
		await this.refreshBoard();
	}

	/** Repository board state is read from the daemon; local task execution is bypassed. */
	async refreshBoard(): Promise<void> {
		const session = this.session; const link = this.link;
		if (this.stopped || !session || !link || session.snapshot.status !== 'attached' || this.boardPendingFor === session || Date.now() < this.boardReadAfter) { return; }
		this.boardPendingFor = session; this.boardReadAfter = Date.now() + 3000;
		try {
			const reply = await session.readService({ type: 'ReadBlackboard', workflow_run_id: '', board_repository: link.repository, include_superseded: false });
			if (this.session !== session || reply.type !== 'BlackboardItems') { return; }
			const tasks = reply.items.filter(item => item.kind === 'task').map(item => {
				const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) ? item.payload : {};
				const state = ({ todo: 'backlog', doing: 'in-progress', review: 'review', done: 'done', failed: 'failed' } as Record<string, string>)[item.status ?? 'todo'] ?? 'backlog';
				return { id: item.id, instruction: typeof payload.title === 'string' ? payload.title : JSON.stringify(item.payload), state,
					assignee: item.assignee, dependencies: [], scopeFiles: [], summary: typeof payload.description === 'string' ? payload.description : undefined };
			});
			const counts: Record<string, number> = {};
			for (const task of tasks) { counts[task.state] = (counts[task.state] ?? 0) + 1; }
			this.post({ type: 'tasksSnapshot', tasks, counts, backend: 'codypendent' });
		} finally { if (this.boardPendingFor === session) { this.boardPendingFor = undefined; } }
	}

	private async waitForRun(session: NodeSession, generation: number, runId: string, signal: AbortSignal): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error): void => { this.waiters.delete(check); signal.removeEventListener('abort', aborted); if (error) { reject(error); } else { resolve(); } };
			const aborted = (): void => finish(new Error(vscode.l10n.t('Stopped observing this run. It remains owned by Codypendent.')));
			const check = (): void => {
				if (this.stopped || this.session !== session || generation !== this.generation || signal.aborted) { aborted(); return; }
				if (['history-unavailable', 'closed'].includes(session.snapshot.status)) { finish(new Error(vscode.l10n.t('The shared transcript could not be restored. Reconnect to observe this daemon-owned run.'))); return; }
				const run = session.snapshot.projection.runs?.find(item => item.id === runId);
				if (run?.disposition?.type === 'Failed') { finish(new Error(run.disposition.reason)); }
				else if (run && ['Completed', 'Cancelled'].includes(run.state)) { finish(); }
			};
			this.waiters.add(check); signal.addEventListener('abort', aborted, { once: true }); check();
		});
	}
	private assertCurrent(session: NodeSession, generation: number, signal: AbortSignal): void {
		if (this.stopped || this.session !== session || generation !== this.generation || signal.aborted) { throw new Error(vscode.l10n.t('This chat request was superseded.')); }
	}
	private post(message: Record<string, unknown>): void { if (!this.stopped) { this.options.post({ ...message, conversationId: this.conversationId }); } }
	private wake(): void { for (const waiter of [...this.waiters]) { waiter(); } }
	private schedulePublish(): void {
		if (this.stopped || this.publishTimer) { return; }
		this.publishTimer = setTimeout(() => {
			this.publishTimer = undefined;
			if (this.session && !this.stopped) {
				this.options.onState(this.session.snapshot, this.conversationId!);
				this.post({ type: 'daemonSnapshot', state: this.session.snapshot, canWrite: vscode.workspace.isTrusted });
			}
		}, 75);
	}
	dispose(): void {
		this.stopped = true; this.generation++; clearTimeout(this.publishTimer);
		clearInterval(this.boardTimer);
		this.trustListener?.dispose();
		this.session?.disconnect(); this.wake();
	}
}

/** Link an existing daemon session into the editor's navigation without copying its ledger. */
export async function pickSharedConversation(store: ConversationStore): Promise<string | undefined> {
	const endpoint = await getDaemonEndpoint();
	await vscode.commands.executeCommand('sota.daemon.ensure', endpoint);
	const session = new NodeSession({ socketPath: endpoint.socketPath,
		clientName: 'son-of-anton-library', canWrite: () => false, onChange: () => {}, onError: () => {} });
	try {
		await session.connect();
		const page = await session.listSessions();
		const chosen = await vscode.window.showQuickPick(page.map(item => ({ label: item.title, description: item.repository ?? item.session_id, session: item })),
			{ title: vscode.l10n.t('Open Shared Conversation') });
		if (!chosen) { return; }
		if ((await getDaemonEndpoint()).identity !== endpoint.identity) { throw new Error(vscode.l10n.t('The agent runtime connection changed. Open the conversation picker again.')); }
		const selected = chosen.session;
		// Search returns repository provenance; old ListSessions peers omit it.
		const repository = selected.repository;
		if (!repository || !isAbsolute(repository)) { throw new Error(vscode.l10n.t('This session has no repository identity. Bind it to a repository in its owning runtime before linking it to the IDE.')); }
		const reverseKey = `sota.daemon.conversation.${endpoint.identity}.${selected.session_id}`;
		const known = context!.workspaceState.get<string>(reverseKey);
		const knownLink = known && context!.workspaceState.get<SessionLink>(`sota.daemon.session.${known}`);
		if (known && knownLink && knownLink.runtimeIdentity === endpoint.identity && knownLink.sessionId === selected.session_id && store.load(known)) { return known; }
		const record = store.create();
		await context!.workspaceState.update(`sota.daemon.session.${record.summary.id}`, { sessionId: selected.session_id, repository, title: selected.title, runtimeIdentity: endpoint.identity });
		await context!.workspaceState.update(reverseKey, record.summary.id);
		store.rename(record.summary.id, selected.title);
		return record.summary.id;
	} finally { session.disconnect(); }
}

/** Native VS Code chat participants use the same daemon instead of a second agent loop. */
export async function runDaemonParticipant(request: vscode.ChatRequest, history: vscode.ChatContext,
	stream: vscode.ChatResponseStream, token: vscode.CancellationToken, specialty?: string): Promise<vscode.ChatResult> {
	const previous = history.history.findLast(turn => turn instanceof vscode.ChatResponseTurn && typeof turn.result.metadata?.sotaSharedConversationId === 'string') as vscode.ChatResponseTurn | undefined;
	const conversationId = previous?.result.metadata?.sotaSharedConversationId as string | undefined ?? randomUUID();
	if (previous?.result.metadata?.daemonSessionId && !hasSharedSession(conversationId)) {
		throw new Error(vscode.l10n.t('The original agent session link is unavailable. Start a new conversation or reopen the original session from its runtime.'));
	}
	if (previous?.result.metadata?.daemonRuntimeIdentity && previous.result.metadata.daemonRuntimeIdentity !== (await getDaemonEndpoint()).identity) {
		throw new Error(vscode.l10n.t('This conversation belongs to a different agent runtime. Select its connection or start a new conversation.'));
	}
	let runId: string | undefined;
	const early: SessionEvent[] = [];
	let earlyBytes = 0;
	const emit = (event: SessionEvent): void => {
		if (event.body.type === 'ModelStreamDelta' && event.body.run_id === runId && !event.body.thought) { stream.markdown(event.body.text); }
	};
	const runtime = new DaemonChat({ post: () => {}, onState: () => {}, title: () => request.prompt.slice(0, 80),
		onEvent: event => { if (runId) { emit(event); } else if (earlyBytes < 256_000) { early.push(event); earlyBytes += JSON.stringify(event).length; } } });
	const cancellation = token.onCancellationRequested(() => { void runtime.cancel().catch(error => stream.markdown(new vscode.MarkdownString().appendText(String(error)))); });
	try {
		if (token.isCancellationRequested) { return {}; }
		if (request.command === 'approve') {
			await vscode.commands.executeCommand('sota.openSharedSessions');
			stream.markdown(new vscode.MarkdownString().appendText(vscode.l10n.t('Review the pending action in Shared Sessions and choose Approve Once or Reject.')));
			return {};
		}
		if (['status', 'metrics'].includes(request.command ?? '')) {
			await runtime.select(conversationId);
			const projection = runtime.snapshot?.projection;
			const report = request.command === 'metrics' ? projection?.runs?.map(run => ({ run: run.id, state: run.state, usage: run.usage ?? 'unknown' }))
				: { sessionId: runtime.sessionId, status: runtime.snapshot?.status, activeRuns: projection?.activeRuns, approvals: projection?.approvals.length, questions: projection?.questions.length };
			stream.markdown(new vscode.MarkdownString().appendCodeblock(JSON.stringify(report, null, 2) ?? 'No runs', 'json'));
			return { metadata: { sotaSharedConversationId: conversationId, daemonRuntimeIdentity: runtime.runtimeIdentity } };
		}
		const readonly = ['review', 'scan', 'audit', 'coverage', 'ci-status'].includes(request.command ?? '');
		const prompt = [specialty ? `Specialty: ${specialty}` : '', request.command ? `Requested operation: ${request.command}` : '', request.prompt].filter(Boolean).join('\n\n');
		await runtime.send(conversationId, prompt, request.command === 'plan' ? 'Plan' : readonly ? 'Review' : 'Build', 'daemon:default', randomUUID(),
			new AbortController().signal, id => { runId = id; for (const event of early.splice(0)) { emit(event); } });
		return { metadata: { sotaSharedConversationId: conversationId, daemonSessionId: runtime.sessionId, daemonRuntimeIdentity: runtime.runtimeIdentity } };
	} finally { cancellation.dispose(); runtime.dispose(); }
}
