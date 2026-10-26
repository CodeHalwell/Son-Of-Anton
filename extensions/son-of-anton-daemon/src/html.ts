/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export function renderSessionHtml(options: { nonce: string; script: string; style: string; cspSource: string; localize: (text: string) => string }): string {
	const { nonce, script, style, cspSource } = options;
	const label = (text: string): string => options.localize(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
	return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head>
<body><h2>${label('Shared Sessions')}</h2><p id="status" role="status"></p><p id="error" role="alert"></p>
<div class="toolbar"><button id="refresh">${label('Refresh')}</button><button id="create">${label('New Session')}</button><button id="reconnect">${label('Reconnect')}</button><button id="disconnect">${label('Disconnect')}</button></div>
<label for="sessions">${label('Session')}</label><div class="toolbar"><select id="sessions"></select><button id="attach">${label('Open')}</button></div>
<h3 id="title"></h3><p id="session-id"></p><p id="history" hidden>${label('Showing retained activity. Full history remains in Codypendent.')}</p>
<p id="trust" hidden>${label('Trust this workspace to send prompts or resolve approvals.')}</p><section id="approvals" aria-label="${label('Approvals')}"></section><section id="questions" aria-label="${label('Questions')}"></section>
<section id="runs" aria-label="${label('Active runs')}"></section><section id="transcript" tabindex="0" aria-label="${label('Transcript')}"></section>
<form id="composer"><label for="prompt">${label('Message')}</label><textarea id="prompt" rows="4" maxlength="100000"></textarea>
<div class="toolbar"><label for="mode">${label('Mode')}</label><select id="mode"><option value="Ask">${label('Ask')}</option><option value="Explore">${label('Explore')}</option><option value="Plan">${label('Plan')}</option><option value="Build" selected>${label('Build')}</option><option value="Review">${label('Review')}</option></select><button id="send" type="submit">${label('Send')}</button></div></form>
<template id="labels"><span data-key="approve">${label('Approve Once')}</span><span data-key="reject">${label('Reject')}</span><span data-key="answer">${label('Answer')}</span><span data-key="cancel">${label('Cancel Run')}</span></template>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
}


/** Board payloads are untrusted: render all card data through textContent. */
export function renderBoardHtml(options: { nonce: string; style: string; cspSource: string; localize: (text: string) => string }): string {
	const { nonce } = options;
	const label = (text: string): string => options.localize(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
	return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${nonce}'">
<link rel="stylesheet" href="${options.style}"></head><body>
<h2>${label('Shared Task Board')}</h2><p id="repository"></p><p>${label('Board status records coordination. Moving a card does not execute a worker or establish validation success.')}</p>
<button id="refresh">${label('Refresh')}</button> <button id="add">${label('New Task')}</button><p id="error" role="alert"></p><p id="truncation" role="status"></p><section id="cards"></section>
<template id="labels"><span id="move-label">${label('Move')}</span><span id="assign-label">${label('Assign')}</span></template>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
for (const type of ['refresh', 'add']) document.getElementById(type).onclick = () => api.postMessage({type});
window.addEventListener('message', ({data}) => {
 if (data.type === 'error') { document.getElementById('error').textContent = data.error; return; }
 if (data.type !== 'board') return;
 document.getElementById('error').textContent = ''; document.getElementById('repository').textContent = data.repository;
 document.getElementById('add').disabled = !data.trusted; document.getElementById('truncation').textContent = data.truncation || '';
 const cards = document.getElementById('cards'); cards.replaceChildren();
 const columns = new Map();
 for (const status of new Set(['todo', 'doing', 'review', 'done', ...data.items.map(item => item.status || 'todo')])) {
  const column = document.createElement('section'), heading = document.createElement('h3'); column.className = 'shared-board-column';
  heading.textContent = status; column.append(heading); columns.set(status, column); cards.append(column);
 }
 for (const item of data.items) {
  const card = document.createElement('article'), title = document.createElement('h4'), detail = document.createElement('p');
  title.textContent = typeof item.payload?.title === 'string' ? item.payload.title : JSON.stringify(item.payload);
  detail.textContent = [item.status || 'todo', item.assignee, 'r' + item.revision].filter(Boolean).join(' · ');
  card.append(title, detail);
  for (const type of ['move', 'assign']) { const button = document.createElement('button'); button.textContent = document.getElementById('labels').content.querySelector('#' + type + '-label').textContent;
   button.disabled = !data.trusted; button.onclick = () => api.postMessage({type, id: item.id}); card.append(button); }
  columns.get(item.status || 'todo').append(card);
 }
}); api.postMessage({type:'ready'});
</script></body></html>`;
}
