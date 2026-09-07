/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { IsolatedWorkspace, type WorkspaceProposal } from 'son-of-anton-core/workspace/IsolatedWorkspace';
import { validationCommands, validationCommandLabel, runProposalValidation } from 'son-of-anton-core/workspace/ProposalValidation';

/** File selection stays in the review panel while native read-only diff editors show the evidence. */
export class ProposalReviewPanel implements vscode.Disposable {
	private readonly panel: vscode.WebviewPanel;
	private readonly subscriptions: vscode.Disposable[] = [];
	private selected: string[];
	private busy = false;
	private validation?: AbortController;
	private closed = false;
	private readonly scheme = `sota-proposal-${randomUUID()}`;
	constructor(private readonly store: IsolatedWorkspace, private proposal: WorkspaceProposal, private readonly displayWorkspace: string, private readonly ensureTrust: () => Promise<boolean>, private readonly changed: (proposal: WorkspaceProposal) => void, private readonly onClose: () => void) {
		this.selected = proposal.files.filter(file => !proposal.appliedFiles?.includes(file));
		this.panel = vscode.window.createWebviewPanel('sota.proposalReview', vscode.l10n.t('Review Proposed Changes'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
		this.subscriptions.push(this.panel.onDidDispose(() => this.dispose()));
		this.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(this.scheme, { provideTextDocumentContent: uri => {
			const values = JSON.parse(uri.query) as { side: string; file: string };
			if (values.side !== 'before' && values.side !== 'after') { throw new Error('Invalid diff side'); }
			return store.fileContent(proposal.id, values.side, values.file);
		} }));
		this.subscriptions.push(this.panel.webview.onDidReceiveMessage((message: { type?: string; files?: string[]; file?: string; index?: number }) => {
			if (message?.type === 'cancel') { this.validation?.abort(); return; }
			if (this.busy) { return; }
			void this.handle(message).catch(error => { void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }).finally(() => { this.busy = false; void this.refresh(); });
		}));
		void this.refresh();
	}
	reveal(): void { this.panel.reveal(); }
	private async refresh(): Promise<void> {
		if (this.closed) { return; }
		this.proposal = await this.store.load(this.proposal.id);
		this.selected = this.selected.filter(file => !this.proposal.appliedFiles?.includes(file));
		if (!this.closed) { this.panel.webview.html = proposalReviewHtml(this.proposal, this.selected, this.busy); }
	}
	private checkBuffers(): void {
		if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' && !path.relative(this.displayWorkspace, document.uri.fsPath).startsWith('..'))) { throw new Error(vscode.l10n.t('Save workspace editor buffers before validating, applying or restoring changes.')); }
	}
	private async handle(message: { type?: string; files?: string[]; file?: string; index?: number }): Promise<void> {
		if (!message || typeof message !== 'object') { return; }
		if (message.type === 'select' && Array.isArray(message.files) && message.files.every(file => typeof file === 'string' && this.proposal.files.includes(file))) { this.selected = [...new Set(message.files)]; return; }
		if (message.type === 'diff' && typeof message.file === 'string' && this.proposal.files.includes(message.file)) {
			const uri = (side: string) => vscode.Uri.from({ scheme: this.scheme, path: `/${message.file}`, query: JSON.stringify({ side, file: message.file }) });
			await vscode.commands.executeCommand('vscode.diff', uri('before'), uri('after'), vscode.l10n.t('{0}: Before ↔ Proposed', message.file), { viewColumn: vscode.ViewColumn.Beside, preview: true }); return;
		}
		if (message.type === 'log' && Number.isInteger(message.index)) {
			const log = this.proposal.validation?.commands[message.index!]?.log;
			if (log) { await vscode.window.showTextDocument(vscode.Uri.file(log), { viewColumn: vscode.ViewColumn.Beside }); } return;
		}
		if (message.type === 'refresh') { return; }
		if (!['validate', 'apply', 'restore'].includes(message.type ?? '')) { return; }
		this.busy = true; await this.refresh();
		if (!await this.ensureTrust()) { return; } this.checkBuffers();
		if (message.type === 'validate') {
			const evidence = await this.store.prepareValidation(this.proposal.id, this.proposal.digest!, this.selected);
			const available = await validationCommands(evidence.workspace);
			if (!available.length) { throw new Error(vscode.l10n.t('No supported package scripts were found. Add a build, typecheck, check, lint or test script to enable host validation.')); }
			const choices = await vscode.window.showQuickPick(available.map(command => ({ label: validationCommandLabel(command), detail: command.body, picked: ['@dependencies', 'typecheck', 'build', 'test'].includes(command.script), command })), { canPickMany: true, title: vscode.l10n.t('Choose Validation Commands'), placeHolder: vscode.l10n.t('Commands run in the displayed order. Review each script before approving execution.') });
			if (!choices?.length) { return; }
			const selected = available.filter(command => choices.some(choice => choice.command.script === command.script));
			const approve = vscode.l10n.t('Run Approved Commands');
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Run these project scripts in the isolated validation workspace?'), { modal: true, detail: `${evidence.workspace}\n\n${selected.map(command => `${validationCommandLabel(command)}\n${command.body}`).join('\n\n')}\n\n${vscode.l10n.t('Scripts can run programs with your user permissions. npm pre/post hooks are disabled.')}` }, approve) !== approve) { return; }
			this.validation = new AbortController(); await this.refresh();
			try { await runProposalValidation(this.store, evidence, selected, this.validation.signal); }
			finally { this.validation = undefined; }
		} else if (message.type === 'apply') {
			const evidence = this.proposal.validation;
			const validated = evidence?.status === 'passed' && JSON.stringify([...this.selected].sort()) === JSON.stringify(evidence.files);
			const apply = validated ? vscode.l10n.t('Apply Selected Changes') : vscode.l10n.t('Apply Without Passing Validation');
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Apply {0} selected files to your project?', this.selected.length), { modal: true, detail: `${this.selected.join('\n')}\n\n${vscode.l10n.t('A checkpoint is saved before application. Unselected files remain in review.')}` }, apply) !== apply) { return; }
			this.checkBuffers(); this.proposal = await this.store.apply(this.proposal.id, this.proposal.digest!, this.selected, validated ? evidence.id : undefined); this.changed(this.proposal);
		} else {
			const application = this.proposal.applications?.slice().reverse().find(item => !item.restored);
			if (!application) { throw new Error(vscode.l10n.t('No completed application is available to restore.')); }
			const restore = vscode.l10n.t('Restore Last Application');
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Restore these files to their state before the last application?'), { modal: true, detail: `${application.files.join('\n')}\n\n${vscode.l10n.t('Unrelated edits are preserved. Newer edits to these files will block restoration.')}\n\n${application.recovery.ref}` }, restore) !== restore) { return; }
			this.checkBuffers(); this.proposal = await this.store.restoreLastApplication(this.proposal.id); this.selected = this.proposal.files.filter(file => !this.proposal.appliedFiles?.includes(file)); this.changed(this.proposal);
		}
	}
	dispose(): void { if (this.closed) { return; } this.closed = true; this.validation?.abort(); this.panel.dispose(); for (const item of this.subscriptions) { item.dispose(); } this.onClose(); }
}

export function proposalReviewHtml(proposal: WorkspaceProposal, selected: string[], busy: boolean): string {
	const nonce = randomUUID(), escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
	const t = (text: string) => escape(vscode.l10n.t(text)), evidence = proposal.validation;
	const status = evidence ? vscode.l10n.t('{0} · {1} Commands', evidence.status, evidence.commands.length) : vscode.l10n.t('Not Yet Validated');
	const files = proposal.files.map((file, index) => `<li><input type="checkbox" aria-label="${escape(vscode.l10n.t('Select {0}', file))}" data-select="${index}" ${selected.includes(file) ? 'checked' : ''} ${busy || proposal.appliedFiles?.includes(file) ? 'disabled' : ''}><button class="file" data-diff="${index}" title="${escape(file)}">${escape(file)}</button>${proposal.appliedFiles?.includes(file) ? `<span class="muted">${t('Applied')}</span>` : ''}</li>`).join('');
	const commands = evidence?.commands.map((command, index) => `<li><button data-log="${index}">${escape(validationCommandLabel(command))}</button><span class="muted">${escape(vscode.l10n.t('Exit {0} · {1}s', String(command.exitCode), (command.durationMs / 1000).toFixed(1)))}</span></li>`).join('') ?? '';
	return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:24px;line-height:1.5}main{max-width:960px;margin:auto}h1{font-size:22px;margin:0 0 6px}h2{font-size:14px;margin:22px 0 8px}.muted,p{color:var(--vscode-descriptionForeground)}.bar{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}button{font:inherit;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);border-radius:4px;padding:6px 10px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button:disabled{opacity:.5;cursor:default}ul{padding:0;list-style:none;border-top:1px solid var(--vscode-panel-border)}li{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}.file{text-align:left;background:none;color:var(--vscode-textLink-foreground);overflow-wrap:anywhere;flex:1}code{overflow-wrap:anywhere}.status{padding:12px 16px;border:1px solid var(--vscode-panel-border);border-radius:6px}input{accent-color:var(--vscode-focusBorder)}
</style></head><body><main><h1>${t('Review Proposed Changes')}</h1><p>${t('Open a file to compare it beside this panel. Select the files you want to validate and apply.')}</p><div class="bar"><button data-action="validate" ${busy || !selected.length ? 'disabled' : ''}>${t('Run Validation')}</button><button class="primary" data-action="apply" ${busy || !selected.length ? 'disabled' : ''}>${t('Apply Selected Changes')}</button><button data-action="restore" ${busy || !proposal.applications?.some(item => !item.restored) ? 'disabled' : ''}>${t('Restore Last Application')}</button><button data-action="refresh" ${busy ? 'disabled' : ''}>${t('Refresh')}</button>${busy ? `<button data-action="cancel">${t('Cancel Validation')}</button>` : ''}</div><div class="status" role="status"><strong>${escape(status)}</strong>${evidence?.error ? `<p>${escape(evidence.error)}</p>` : ''}<div class="muted">${t('Results apply only to the tested selection and workspace state.')}</div></div><h2>${escape(vscode.l10n.t('{0} of {1} Files Selected', selected.length, proposal.files.length))}</h2><ul>${files}</ul>${commands ? `<h2>${t('Host Validation Results')}</h2><ul>${commands}</ul>` : ''}<p>${t('Proposed changes and recovery checkpoints are retained locally.')}</p></main><script nonce="${nonce}">
const vscode=acquireVsCodeApi();const files=${JSON.stringify(proposal.files).replaceAll('<', '\\u003c')};document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:button.dataset.action})));document.querySelectorAll('[data-diff]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'diff',file:files[Number(button.dataset.diff)]})));document.querySelectorAll('[data-log]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'log',index:Number(button.dataset.log)})));document.querySelectorAll('[data-select]').forEach(input=>input.addEventListener('change',()=>vscode.postMessage({type:'select',files:[...document.querySelectorAll('[data-select]:checked')].map(input=>files[Number(input.dataset.select)])})));
</script></body></html>`;
}
