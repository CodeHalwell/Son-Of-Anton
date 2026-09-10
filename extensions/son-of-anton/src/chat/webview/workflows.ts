/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export { contextMentions, inlineUrlMentions, mentionSourceId, migrateMentionExclusions } from '../ContextSources';

type Text = (key: string, ...args: Array<string | number>) => string;
type QueueAction = 'remove' | 'edit' | 'up' | 'down' | 'resume' | 'pause';

function button(label: string, action: () => void): HTMLButtonElement {
	const element = document.createElement('button');
	element.type = 'button'; element.textContent = label; element.setAttribute('aria-label', label);
	element.addEventListener('click', action);
	return element;
}

/** Render authoritative host queue snapshots; draft bodies remain in the host. */
export function renderQueue(root: HTMLElement, entries: Array<{ id: string; label: string }>, paused: boolean, act: (action: QueueAction, id?: string) => void, text: Text): void {
	const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.queueFocus : undefined;
	root.replaceChildren(); root.hidden = entries.length === 0;
	const heading = document.createElement('div'); heading.className = 'followup-queue-heading';
	const title = document.createElement('strong'); title.textContent = text(paused ? 'queuePaused' : 'queueCount', entries.length); heading.append(title);
	heading.append(button(text(paused ? 'resumeQueue' : 'pauseQueue'), () => act(paused ? 'resume' : 'pause')));
	root.append(heading);
	const list = document.createElement('ol');
	for (const [index, entry] of entries.entries()) {
		const row = document.createElement('li');
		const label = document.createElement('span'); label.textContent = entry.label; row.append(label);
		for (const [action, key] of [['up', 'moveEarlier'], ['down', 'moveLater'], ['edit', 'editQueued'], ['remove', 'removeQueued']] as const) {
			const control = button(text(key), () => act(action, entry.id)); control.dataset.queueFocus = `${entry.id}:${action}`;
			control.disabled = action === 'up' && index === 0 || action === 'down' && index === entries.length - 1;
			row.append(control);
		}
		list.append(row);
	}
	root.append(list);
	if (focus) { Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(control => control.dataset.queueFocus === focus)?.focus(); }
}

/** A typed, keyboard-accessible action toolbar shared by live and restored responses. */
export function responseActions(options: {
	text: Text; copy: () => void; reuse: () => void; branch: () => void;
	feedback: (value: 'up' | 'down' | '') => void; rating?: 'up' | 'down'; canReuse: boolean; canPersist: boolean; busy: boolean; branchBusy: boolean;
}): HTMLElement {
	const bar = document.createElement('div'); bar.className = 'msg-actions'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', options.text('messageActions'));
	const copy = button(options.text('copyMessage'), options.copy); copy.className = 'msg-action';
	const reuse = button(options.text('reusePrompt'), options.reuse); reuse.className = 'msg-action msg-action-reuse'; reuse.disabled = options.busy; reuse.hidden = !options.canReuse;
	const branch = button(options.text('branchHere'), options.branch); branch.className = 'msg-action msg-action-branch'; branch.disabled = options.busy || options.branchBusy; branch.hidden = !options.canPersist;
	bar.append(copy, reuse, branch);
	let rating = options.rating;
	const votes = new Map<'up' | 'down', HTMLButtonElement>();
	for (const value of ['up', 'down'] as const) {
		const control = button(options.text(value === 'up' ? 'helpful' : 'notHelpful'), () => {
			rating = rating === value ? undefined : value;
			for (const [key, vote] of votes) { vote.setAttribute('aria-pressed', String(rating === key)); vote.classList.toggle('is-active', rating === key); }
			options.feedback(rating ?? '');
		});
		control.hidden = !options.canPersist; control.className = 'msg-action msg-action-fb'; control.setAttribute('aria-pressed', String(rating === value)); control.classList.toggle('is-active', rating === value);
		votes.set(value, control); bar.append(control);
	}
	bar.addEventListener('keydown', event => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { return; }
		const controls = Array.from(bar.querySelectorAll('button')).filter(control => !control.hidden && !control.disabled);
		const index = controls.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
		controls[next]?.focus(); event.preventDefault();
	});
	return bar;
}

/** Each source can be inspected and removed without disabling unrelated context. */
export function renderContext(root: HTMLElement, sections: Array<{ id: string; label: string; markdown: string; estimatedTokens: number; excluded: boolean }>, toggle: (id: string, included: boolean) => void, text: Text): void {
	root.replaceChildren();
	for (const section of sections) {
		const row = document.createElement('details'); row.className = 'context-source';
		const summary = document.createElement('summary');
		const label = document.createElement('label');
		const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !section.excluded; check.setAttribute('aria-label', text('includeSource', section.label));
		check.addEventListener('click', event => event.stopPropagation()); check.addEventListener('change', () => toggle(section.id, check.checked));
		label.append(check, document.createTextNode(`${section.label} · ${section.estimatedTokens.toLocaleString()} ${text('estimatedTokens')}`)); summary.append(label);
		const content = document.createElement('pre'); content.textContent = section.excluded ? text('sourceExcluded') : section.markdown || text('contextEmpty');
		row.append(summary, content); root.append(row);
	}
	if (!sections.length) { root.textContent = text('contextEmpty'); }
}

/** Discovery reports installation, credentials, catalog access and inference separately. */
export function renderProviderInventory(root: HTMLElement, snapshot: {
	updatedAt: number;
	software: Array<{ name: string; installed: boolean; auth: string; configFiles: string[]; configuredModels?: string[]; modelCatalog?: LocalModelCatalog }>;
	providers: Array<{ id: string; name: string; credentialSource: string; catalogStatus: string; inferenceStatus: string; catalogScope?: string; fetchedAt?: number; models: readonly object[]; error?: string; truncated?: boolean; localModelCatalog?: LocalModelCatalog }>;
}, text: Text): void {
	root.replaceChildren();
	const status = document.createElement('p'); status.textContent = text('discoveryUpdated', snapshot.updatedAt ? new Date(snapshot.updatedAt).toLocaleString() : text('notChecked')); root.append(status);
	const list = document.createElement('ul'); list.className = 'provider-inventory';
	for (const provider of snapshot.providers) {
		const row = document.createElement('li');
		const name = document.createElement('strong'); name.textContent = provider.name; row.append(name);
		const details = document.createElement('span'); details.textContent = `${provider.catalogStatus.replaceAll('-', ' ')} · ${text('models', provider.models.length)} · ${text('credentials', provider.credentialSource.replaceAll('-', ' '))} · ${text('inference', provider.inferenceStatus.replaceAll('-', ' '))}`; row.append(details);
		if (provider.error || provider.truncated) { const note = document.createElement('p'); note.textContent = provider.error || text('catalogTruncated'); row.append(note); }
		if (provider.catalogScope) { const scope = document.createElement('p'); scope.textContent = provider.catalogScope; row.append(scope); }
		if (provider.localModelCatalog) { appendLocalModels(row, provider.localModelCatalog, text); }
		list.append(row);
	}
	root.append(list);
	const tools = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = text('detectedCodingTools'); tools.append(summary);
	for (const software of snapshot.software.filter(item => item.installed || item.configFiles.length)) {
		const item = document.createElement('p'); item.textContent = `${software.name} · ${software.installed ? text('installed') : text('configurationFound')} · ${software.auth === 'file-present' ? text('authFilePresent') : text('authNotDetected')}`; tools.append(item);
		if (software.modelCatalog) { appendLocalModels(tools, software.modelCatalog, text); }
		else if (software.configuredModels?.length) { const models = document.createElement('p'); models.textContent = text('localModelCatalog', software.configuredModels.join(', ')); tools.append(models); }
	}
	root.append(tools);
}

interface LocalModelCatalog { source: string; updatedAt: number; models: Array<{ id: string; label: string }> }
function appendLocalModels(root: HTMLElement, catalog: LocalModelCatalog, text: Text): void {
	const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = text('localModelCatalog', catalog.models.length); details.append(summary);
	const source = document.createElement('p'); source.textContent = text('localModelCatalogSource', catalog.source, new Date(catalog.updatedAt).toLocaleString()); details.append(source);
	const scope = document.createElement('p'); scope.textContent = text('localModelsNeedAdapter'); details.append(scope);
	for (const model of catalog.models) { const row = document.createElement('p'); row.textContent = `${model.label} · ${model.id}`; details.append(row); }
	root.append(details);
}

export { TimelineWindow } from './TimelineWindow';
