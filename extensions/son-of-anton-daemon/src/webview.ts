/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { SharedSessionState } from './session.js';
import type { SessionSummary } from '@codypendent/protocol';
declare function acquireVsCodeApi(): { postMessage(message: object): void; getState(): { draft?: string; mode?: string } | undefined; setState(value: object): void };
const vscode = acquireVsCodeApi();
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const prompt = element<HTMLTextAreaElement>('prompt');
const mode = element<HTMLSelectElement>('mode');
const sessions = element<HTMLSelectElement>('sessions');
const labels = element<HTMLTemplateElement>('labels').content;
let current: SharedSessionState | undefined;
let trusted = false;
let pending: string | undefined;
const saved = vscode.getState();
prompt.value = saved?.draft ?? '';
if (saved?.mode && ['Ask', 'Explore', 'Plan', 'Build', 'Review'].includes(saved.mode)) { mode.value = saved.mode; }
function save(): void { vscode.setState({ draft: prompt.value, mode: mode.value }); }
prompt.addEventListener('input', save); mode.addEventListener('change', save);

function button(key: string, type: string, id: string): HTMLButtonElement {
	const node = document.createElement('button');
	node.textContent = labels.querySelector(`[data-key="${key}"]`)?.textContent ?? key;
	node.disabled = !trusted || current?.status !== 'attached';
	node.addEventListener('click', () => vscode.postMessage({ type, id, sessionId: current?.sessionId }));
	return node;
}
function controls(): void {
	element<HTMLButtonElement>('send').disabled = !!pending || !trusted || current?.status !== 'attached';
	element<HTMLButtonElement>('create').disabled = !trusted;
}
for (const type of ['refresh', 'create', 'reconnect', 'disconnect']) {
	element(type).addEventListener('click', () => vscode.postMessage({ type }));
}
element('attach').addEventListener('click', () => { if (sessions.value) { vscode.postMessage({ type: 'attach', sessionId: sessions.value }); } });
element('composer').addEventListener('submit', event => {
	event.preventDefault();
	if (!prompt.value.trim() || !current?.sessionId || pending || !trusted || current.status !== 'attached') { return; }
	pending = crypto.randomUUID(); controls();
	vscode.postMessage({ type: 'submit', requestId: pending, sessionId: current.sessionId, text: prompt.value, mode: mode.value });
});
window.addEventListener('message', (event: MessageEvent) => {
	const message = event.data;
	if (message.type === 'submitted' && message.requestId === pending) {
		if (message.accepted) { prompt.value = ''; save(); }
		pending = undefined; controls(); return;
	}
	if (message.type !== 'state') { return; }
	current = message.state as SharedSessionState | undefined;
	trusted = message.trusted === true;
	element('error').textContent = message.error || '';
	element('status').textContent = current?.status ?? 'closed';
	element('title').textContent = current?.projection.title ?? '';
	element('session-id').textContent = current?.sessionId ?? '';
	element('history').hidden = !current?.projection.historyTruncated;
	element('trust').hidden = trusted;
	const selected = sessions.value;
	sessions.replaceChildren(...(message.library as SessionSummary[]).map(session => {
		const option = document.createElement('option'); option.value = session.session_id;
		option.textContent = `${session.title} · ${session.session_id.slice(0, 8)}`; return option;
	}));
	sessions.value = selected || current?.sessionId || sessions.options[0]?.value || '';
	const transcript = element('transcript');
	const follow = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 40;
	transcript.replaceChildren(...(current?.projection.rows ?? []).map(row => {
		const node = document.createElement('pre'); node.className = row.kind; node.textContent = row.text; return node;
	}));
	if (follow) { transcript.scrollTop = transcript.scrollHeight; }
	element('approvals').replaceChildren(...(current?.projection.approvals ?? []).map(approval => {
		const card = document.createElement('article'); const text = document.createElement('pre');
		text.textContent = `${approval.risk}: ${approval.action}`;
		card.append(text, button('approve', 'approve', approval.id), button('reject', 'reject', approval.id)); return card;
	}));
	element('questions').replaceChildren(...(current?.projection.questions ?? []).map(question => {
		const card = document.createElement('article'); const text = document.createElement('p');
		text.textContent = question.questions.map(prompt => prompt.question).join('\n');
		card.append(text, button('answer', 'question', question.id)); return card;
	}));
	element('runs').replaceChildren(...(current?.projection.activeRuns ?? []).map(id => button('cancel', 'cancel', id)));
	controls();
});
controls(); vscode.postMessage({ type: 'ready' });
