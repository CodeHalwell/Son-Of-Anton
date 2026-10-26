/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { IdeContextUpdate, SessionSummary } from '@codypendent/protocol';
import { SharedSession } from './session.js';
import { renderSessionHtml } from './html.js';
import { parseViewMessage, type ViewMessage } from './messages.js';
import { ensureDaemon, openTerminal, openCouncil } from './runtime.js';
import { openBoard } from './board.js';
import { registerGraphCommands } from './graph.js';

class SharedSessionView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view?: vscode.WebviewView;
	private session?: SharedSession;
	private library: SessionSummary[] = [];
	private disposables: vscode.Disposable[] = [];
	private viewDisposables: vscode.Disposable[] = [];
	private publishTimer?: ReturnType<typeof setTimeout>;
	private editorTimer?: ReturnType<typeof setTimeout>;
	private operations = Promise.resolve();
	private disposed = false;
	private diagnosticsRevision = 0;
	private error = '';

	constructor(private readonly context: vscode.ExtensionContext) {
		const schedule = (): void => {
			clearTimeout(this.editorTimer);
			this.editorTimer = setTimeout(() => this.pushEditorContext(), 300);
		};
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(schedule),
			vscode.window.onDidChangeTextEditorSelection(schedule), vscode.workspace.onDidChangeTextDocument(schedule),
			vscode.languages.onDidChangeDiagnostics(() => { this.diagnosticsRevision++; schedule(); }),
			vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.reconnect().catch(error => this.showError(error)); }),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('sota.daemon.socketPath')) { void this.reconnect().catch(error => this.showError(error)); }
			}));
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		for (const disposable of this.viewDisposables.splice(0)) { disposable.dispose(); }
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
		view.webview.html = this.html(view.webview);
		this.viewDisposables.push(view.webview.onDidReceiveMessage((raw: unknown) => {
			const message = parseViewMessage(raw);
			if (!message) { return; }
			this.operations = this.operations.then(() => this.handle(message)).catch(error => {
				if (message.type === 'submit') { void this.view?.webview.postMessage({ type: 'submitted', requestId: message.requestId, accepted: false }); }
				this.showError(error);
			});
		}), view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } }));
	}

	private newConnection(): SharedSession {
		this.session?.disconnect();
		this.session = new SharedSession({
			clientName: 'son-of-anton', clientVersion: '0.1.0',
			socketPath: vscode.workspace.getConfiguration('sota.daemon').get<string>('socketPath') || undefined,
			canWrite: () => vscode.workspace.isTrusted,
			onChange: () => this.schedulePublish(), onError: message => { this.error = message; this.schedulePublish(); },
		});
		return this.session;
	}

	private async refresh(): Promise<void> {
		await ensureDaemon(this.context);
		if (!this.session || this.session.snapshot.status === 'closed') { await this.newConnection().connect(); }
		this.library = await this.session!.listSessions();
		this.error = '';
		this.schedulePublish();
	}

	private async attach(session: SessionSummary): Promise<void> {
		await ensureDaemon(this.context);
		await this.newConnection().connect(session);
		await this.context.workspaceState.update('sharedSessions.lastSessionId', session.session_id);
		this.error = '';
		this.pushEditorContext();
	}

	private async reconnect(): Promise<void> {
		if (this.disposed) { return; }
		await ensureDaemon(this.context);
		const id = this.session?.snapshot.sessionId;
		const selected = this.library.find(session => session.session_id === id);
		if (selected) { await this.attach(selected); }
		else { await this.newConnection().connect(); await this.refresh(); }
	}

	async openKnowledge(): Promise<void> {
		await this.refresh();
		const chosen = await vscode.window.showQuickPick(this.library.map(session => ({ label: session.title, description: session.repository ?? session.session_id, session })),
			{ title: vscode.l10n.t('Knowledge Session') });
		if (!chosen) { return; }
		const section = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Skills'), type: 'Skills' as const }, { label: vscode.l10n.t('Memories'), type: 'Memories' as const },
			{ label: vscode.l10n.t('Learnings'), type: 'Learnings' as const }, { label: vscode.l10n.t('Documents'), type: 'Documents' as const }],
			{ title: vscode.l10n.t('Knowledge Section') });
		if (!section) { return; }
		const reply = await this.session!.readService({
			type: 'ReadKnowledge', session_id: chosen.session.session_id,
			section: { type: section.type }, offset: 0, limit: 100
		});
		if (reply.type !== 'KnowledgePage') { throw new Error(vscode.l10n.t('The daemon did not return a knowledge page.')); }
		const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(reply.page, null, 2) });
		await vscode.window.showTextDocument(document, { preview: true });
	}

	async recordMemory(): Promise<void> {
		if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before recording memory.')); }
		await ensureDaemon(this.context); await this.refresh();
		const selected = await vscode.window.showQuickPick(this.library.map(session => ({ label: session.title, description: session.repository ?? session.session_id, session })),
			{ title: vscode.l10n.t('Memory Session') });
		if (!selected) { return; }
		const text = await vscode.window.showInputBox({ prompt: vscode.l10n.t('What should be remembered?'), validateInput: value => value.length > 20_000 ? vscode.l10n.t('Use at most 20,000 characters.') : undefined });
		if (!text?.trim()) { return; }
		await this.attach(selected.session);
		await this.session!.rememberMemory(text.trim());
		void vscode.window.showInformationMessage(vscode.l10n.t('Memory request recorded. Inspect shared memory for the curation outcome.'));
	}

	private async handle(message: ViewMessage): Promise<void> {
		if (this.disposed) { return; }
		if ((message.type === 'submit' || message.type === 'approve' || message.type === 'reject' || message.type === 'question' || message.type === 'cancel')
			&& message.sessionId !== this.session?.snapshot.sessionId) {
			throw new Error(vscode.l10n.t('The selected session changed. Retry from the current session.'));
		}
		switch (message.type) {
			case 'ready': {
				await ensureDaemon(this.context);
				if (this.session) { this.schedulePublish(); return; }
				await this.refresh();
				const last = this.context.workspaceState.get<string>('sharedSessions.lastSessionId');
				const selected = this.library.find(session => session.session_id === last);
				if (selected) { await this.attach(selected); }
				break;
			}
			case 'refresh': await this.refresh(); break;
			case 'disconnect': this.session?.disconnect(); this.schedulePublish(); break;
			case 'reconnect': await this.reconnect(); break;
			case 'attach': {
				const selected = this.library.find(session => session.session_id === message.sessionId);
				if (!selected) { throw new Error(vscode.l10n.t('Refresh the session list before opening this session.')); }
				await this.attach(selected); break;
			}
			case 'create': {
				if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before creating a session.')); }
				const folders = vscode.workspace.workspaceFolders ?? [];
				const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
				if (!folder || folder.uri.scheme !== 'file') { return; }
				const title = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Name the shared session'), value: folder.name });
				if (!title?.trim()) { return; }
				await this.refresh();
				let workspace = this.context.workspaceState.get<string>('sharedSessions.workspaceId');
				if (!workspace) { workspace = randomUUID(); await this.context.workspaceState.update('sharedSessions.workspaceId', workspace); }
				const id = await this.session!.createSession(title.trim(), workspace, realpathSync(folder.uri.fsPath));
				await this.context.workspaceState.update('sharedSessions.lastSessionId', id);
				await this.refresh(); this.pushEditorContext(); break;
			}
			case 'submit':
				await this.session!.submit(message.text, message.mode);
				void this.view?.webview.postMessage({ type: 'submitted', requestId: message.requestId, accepted: true }); break;
			case 'approve': case 'reject': await this.session!.resolveApproval(message.id, message.type === 'approve'); break;
			case 'cancel': await this.session!.cancelRun(message.id); break;
			case 'question': {
				const question = this.session!.snapshot.projection.questions.find(item => item.id === message.id);
				if (!question) { return; }
				const answers: string[][] = [];
				for (const prompt of question.questions) {
					const items = prompt.options.map(option => ({ label: option.label, description: option.description, custom: false }));
					if (prompt.custom !== false) { items.push({ label: vscode.l10n.t('Write an answer…'), description: '', custom: true }); }
					const selection = await vscode.window.showQuickPick(items, { title: prompt.header, placeHolder: prompt.question, canPickMany: prompt.multiple });
					if (!selection) { return; }
					const chosen = Array.isArray(selection) ? selection : [selection];
					const values: string[] = [];
					for (const item of chosen) {
						const value = item.custom ? await vscode.window.showInputBox({ prompt: prompt.question }) : item.label;
						if (value === undefined) { return; } values.push(value);
					}
					if (!values.length) { return; } answers.push(values);
				}
				await this.session!.resolveQuestion(message.id, { type: 'Answered', answers }); break;
			}
		}
	}

	private pushEditorContext(): void {
		const repository = this.session?.repositoryRoot;
		if (!repository || !vscode.workspace.isTrusted) { return; }
		const belongs = (file: string): boolean => {
			try { const relative = path.relative(repository, realpathSync(file)); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
			catch { return false; }
		};
		const editor = vscode.window.activeTextEditor;
		const update: IdeContextUpdate = {
			diagnostics_revision: this.diagnosticsRevision,
			open_files: vscode.workspace.textDocuments.filter(document => document.uri.scheme === 'file' && belongs(document.uri.fsPath)).map(document => document.uri.fsPath),
			dirty_buffers: vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file' && belongs(document.uri.fsPath)).map(document => {
				const text = document.getText(); return { path: document.uri.fsPath, sha256: createHash('sha256').update(text).digest('hex'), byte_length: Buffer.byteLength(text) };
			})
		};
		if (editor?.document.uri.scheme === 'file' && belongs(editor.document.uri.fsPath)) {
			update.active_file = editor.document.uri.fsPath;
			update.selection = { path: editor.document.uri.fsPath, range: { start: editor.selection.start, end: editor.selection.end } };
		}
		this.session?.updateEditorContext(update);
	}

	private schedulePublish(): void {
		if (this.disposed || this.publishTimer) { return; }
		this.publishTimer = setTimeout(() => {
			this.publishTimer = undefined;
			void this.view?.webview.postMessage({
				type: 'state', state: this.session?.snapshot,
				library: this.library, trusted: vscode.workspace.isTrusted, error: this.error
			});
		}, 50);
	}
	private showError(error: Error): void { this.error = error.message; this.schedulePublish(); }

	private html(webview: vscode.Webview): string {
		return renderSessionHtml({
			nonce: randomBytes(24).toString('hex'),
			script: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist/webview.js')).toString(),
			style: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media/session.css')).toString(),
			cspSource: webview.cspSource, localize: text => vscode.l10n.t(text)
		});
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.publishTimer); clearTimeout(this.editorTimer);
		this.session?.disconnect();
		for (const disposable of [...this.viewDisposables, ...this.disposables]) { disposable.dispose(); }
	}
}

export function activate(context: vscode.ExtensionContext): void {
	registerGraphCommands(context);
	const provider = new SharedSessionView(context);
	context.subscriptions.push(provider, vscode.window.registerWebviewViewProvider('sota.sharedSessions', provider),
		vscode.commands.registerCommand('sota.daemon.ensure', () => ensureDaemon(context)),
		vscode.commands.registerCommand('sota.daemon.terminal', () => openTerminal(context)),
		vscode.commands.registerCommand('sota.daemon.council', (history?: boolean) => openCouncil(context, history)),
		vscode.commands.registerCommand('sota.daemon.board', () => openBoard(context)),
		vscode.commands.registerCommand('sota.daemon.recordMemory', () => provider.recordMemory()),
		vscode.commands.registerCommand('sota.daemon.knowledge', () => provider.openKnowledge()),
		vscode.commands.registerCommand('sota.openSharedSessions', () => vscode.commands.executeCommand('sota.sharedSessions.focus')));
}
