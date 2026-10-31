/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { CodeGraphSourceLocation, Payload } from '@codypendent/protocol';
import type { GraphSelection, GraphViewPosition } from './graphHistory.js';

export interface GraphViewOptions {
	nonce: string;
	version: number;
	repository: string;
	selection?: GraphSelection;
	canGoBack?: boolean;
	position?: GraphViewPosition;
	status: Extract<Payload, { type: 'CodeGraphStatus' }>['status'];
	page: Extract<Payload, { type: 'CodeGraphPage' }>['page'];
	localize: (text: string, ...args: Array<string | number>) => string;
}

function escapeGraphText(value: string | number): string {
	return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[character]!));
}

/** Show progress while the isolated runtime connects, before any graph has been returned. */
export function renderGraphLoadingHtml(repository: string, localize: GraphViewOptions['localize']): string {
	return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';"><title>${escapeGraphText(localize('Code Graph'))}</title></head><body><h1>${escapeGraphText(localize('Code Graph'))}</h1><p><code>${escapeGraphText(repository)}</code></p><p role="status">${escapeGraphText(localize('Loading recorded graph…'))}</p></body></html>`;
}

/** Render recorded graph evidence without granting the webview filesystem access. */
export function renderGraphHtml(options: GraphViewOptions): string {
	if (!Number.isSafeInteger(options.version) || options.version < 0) { throw new Error(options.localize('Invalid graph view version.')); }
	const { page, status, selection } = options;
	const escape = escapeGraphText;
	const label = (text: string, ...args: Array<string | number>): string => escape(options.localize(text, ...args));
	const nonce = escape(options.nonce);
	const nodes = new Map([...page.nodes, ...(page.related_nodes ?? [])].map(node => [node.id, node]));
	const matchingIds = new Set(page.nodes.map(node => node.id));
	const related = [...new Map((page.related_nodes ?? []).filter(node => !matchingIds.has(node.id)).map(node => [node.id, node])).values()];
	const selected = selection?.nodeId ? nodes.get(selection.nodeId) : undefined;
	const locationText = (location: Pick<CodeGraphSourceLocation, 'source_path' | 'line' | 'column'>): string => `${location.source_path}:${location.line}:${location.column}`;
	const nodeButton = (id: string, name: string, focusKey = `select:${id}`): string => nodes.has(id)
		? `<button type="button" class="symbol-link" data-select-id="${escape(id)}" data-focus-key="${escape(focusKey)}" aria-label="${label('Inspect {0}', name)}">${escape(name)}</button>`
		: `<span>${escape(name)}</span>`;
	const renderNode = (node: GraphViewOptions['page']['nodes'][number]): string => {
		const source = node.location?.source_path || node.source_path;
		const open = source ? `<button type="button" data-source-id="${escape(`node:${node.id}`)}" data-focus-key="${escape(`source:node:${node.id}`)}">${label(node.location ? 'Open Definition' : 'Open File')}</button>` : '';
		return `<article class="symbol-row${node.id === selected?.id ? ' selected' : ''}" data-node-id="${escape(node.id)}">
<div class="row-heading">${nodeButton(node.id, node.qualified_name)}${node.id === selected?.id ? `<span class="badge">${label('Selected')}</span>` : ''}${open}</div>
<div class="metadata"><span>${label('Kind: {0}', node.kind)}</span><span>${label('Language: {0}', node.language)}</span>${node.package ? `<span>${label('Package: {0}', node.package)}</span>` : ''}</div>
<div class="source">${source ? `<code>${escape(node.location ? locationText(node.location) : source)}</code>` : label('Source location unavailable.')}</div>
${!node.location ? `<p class="muted">${label('Verified definition location unavailable.')}</p>` : ''}
<div class="muted">${label('Recorded revision: {0}', node.revision)}</div></article>`;
	};
	const relationships = page.edges.map((edge, index) => {
		const direction = selected ? edge.from_id === selected.id && edge.to_id === selected.id ? 'Self Relation' : edge.from_id === selected.id ? 'Outgoing' : edge.to_id === selected.id ? 'Incoming' : 'Recorded Relation' : 'Recorded Relation';
		const confidence = Number.isFinite(edge.confidence) && edge.confidence >= 0 && edge.confidence <= 1
			? label('{0}%', Number((edge.confidence * 100).toFixed(1))) : label('Unavailable');
		return `<li class="relationship" data-edge-index="${index}">
<div class="row-heading"><span class="badge">${label(direction)}</span>${nodeButton(edge.from_id, edge.from_name, `relation:${index}:from`)}<span class="relation">${escape(edge.relation)}</span><span aria-hidden="true">→</span>${nodeButton(edge.to_id, edge.to_name, `relation:${index}:to`)}</div>
<dl><div><dt>${label('Evidence Kind')}</dt><dd>${escape(edge.evidence_kind)}</dd></div><div><dt>${label('Recorded Confidence')}</dt><dd>${confidence}</dd></div><div><dt>${label('Recorded Revision')}</dt><dd><code>${escape(edge.revision)}</code></dd></div></dl>
${edge.call_site ? `<p class="source"><code>${escape(locationText(edge.call_site))}</code> <button type="button" data-source-id="${escape(`edge:${index}`)}" data-focus-key="source:edge:${index}">${label('Open Call Site')}</button></p>` : `<p class="muted">${label('Call site unavailable.')}</p>`}
${edge.asserted_by ? `<details class="assertion"><summary>${label('Agent Assertion')}</summary><p>${escape(edge.asserted_by.rationale)}</p><dl><div><dt>${label('Asserting Session')}</dt><dd><code>${escape(edge.asserted_by.session_id)}</code></dd></div><div><dt>${label('Asserting Run')}</dt><dd><code>${escape(edge.asserted_by.run_id)}</code></dd></div></dl></details>` : ''}</li>`;
	}).join('');
	const storedRevisions = status.revisions.length
		? status.revisions.map(revision => `<li><code>${escape(revision.label)}</code> — ${label('{0} nodes', revision.count)}</li>`).join('')
		: `<li>${label('No recorded revisions.')}</li>`;
	return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${label('Code Graph')}</title><style nonce="${nonce}">
body{margin:0;padding:20px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size,13px) var(--vscode-font-family,system-ui);line-height:1.5}
h1{font-size:20px;margin:0}h2{font-size:16px;margin:20px 0 4px}h3{font-size:14px}p{margin:6px 0}code{font-family:var(--vscode-editor-font-family,monospace);overflow-wrap:anywhere}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:1px solid transparent;padding:4px 9px;cursor:pointer;border-radius:3px}button:hover{background:var(--vscode-button-hoverBackground)}button:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.toolbar,.row-heading,.metadata{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.toolbar{margin:12px 0}.symbol-link{padding:0;background:transparent;color:var(--vscode-textLink-foreground);text-align:left;overflow-wrap:anywhere}.symbol-link:hover{background:transparent;text-decoration:underline}.muted,.metadata,dt{color:var(--vscode-descriptionForeground)}.metadata{font-size:12px}.repository,.source,.assertion p{overflow-wrap:anywhere}.freshness{border-left:3px solid var(--vscode-charts-green);background:var(--vscode-textCodeBlock-background);padding:10px 12px;margin:12px 0}.freshness.stale{border-color:var(--vscode-editorWarning-foreground)}.symbol-row,.relationship{border:1px solid var(--vscode-panel-border);padding:10px 12px;margin:8px 0;border-radius:4px}.symbol-row.selected{border-color:var(--vscode-focusBorder)}.badge{font-size:11px;padding:1px 6px;border-radius:3px;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background)}.relationships{list-style:none;padding:0}.relation{font-weight:600}dl{display:flex;flex-wrap:wrap;gap:8px 24px;margin:6px 0}dt{font-size:11px}dd{margin:0;overflow-wrap:anywhere}details{margin:8px 0}summary{cursor:pointer}.disclaimer{max-width:85ch}.empty{padding:12px 0}#graph-error{color:var(--vscode-errorForeground)}
button:disabled{opacity:.6;cursor:default}input{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:3px;padding:5px 7px;min-width:0;width:100%;box-sizing:border-box}input:focus-visible,[tabindex="-1"]:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.query-form{display:flex;flex-wrap:wrap;gap:10px;align-items:end;margin:16px 0 4px}.query-form label{display:grid;gap:4px;flex:1 1 220px}.query-form label span{font-weight:600}.query-form button{padding:5px 12px}.query-help{margin-bottom:12px}.toolbar button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}#graph-progress{min-height:1.5em}
</style></head><body data-version="${options.version}" data-restore-scroll="${Number.isFinite(options.position?.scrollY) ? Math.max(0, options.position!.scrollY) : 0}" data-restore-focus="${escape(options.position?.focus ?? '')}">
<header><h1>${label('Code Graph')}</h1><p class="repository"><code>${escape(options.repository)}</code></p>
<p class="disclaimer muted">${label('Structural graph evidence. This bounded view does not establish complete impact or measured test coverage. Recorded confidence describes graph evidence, not runtime behavior.')}</p>
<form id="graph-query" class="query-form" aria-describedby="query-help"><label for="query-path"><span>${label('Path Prefix')}</span><input id="query-path" name="path" data-focus-key="query-path" maxlength="2048" value="${escape(selection?.path ?? '')}" placeholder="${label('For example, src/')}" autocomplete="off" spellcheck="false"></label><label for="query-name"><span>${label('Symbol Name Contains')}</span><input id="query-name" name="name" data-focus-key="query-name" maxlength="2048" value="${escape(selection?.name ?? '')}" placeholder="${label('For example, handleRequest')}" autocomplete="off" spellcheck="false"></label><button type="submit" data-focus-key="query-submit">${label('Search')}</button></form>
<p id="query-help" class="query-help muted">${label('Search recorded paths and symbol names. Inspect a result to browse its relationships; Back restores your previous view.')}</p>
<div class="toolbar"><button type="button" class="secondary" data-action="back" data-focus-key="back"${options.canGoBack ? '' : ' disabled'}>${label('Back')}</button><button type="button" class="secondary" data-action="reset" data-focus-key="reset">${label('Repository Overview')}</button><button type="button" class="secondary" data-action="refresh" data-focus-key="refresh">${label('Refresh')}</button><button type="button" class="secondary" data-action="raw" data-focus-key="raw">${label('View Raw Data')}</button></div>
<p id="graph-progress" role="status" aria-live="polite" data-loading="${label('Loading recorded graph…')}">${label('Showing {0} matching nodes and {1} relationships in this page.', page.nodes.length, page.edges.length)}</p>
<p id="graph-error" role="alert"></p>
<div class="freshness${status.stale ? ' stale' : ''}" role="status"><strong>${label(status.stale ? 'Saved Graph Is Stale' : 'Saved Graph Is Current')}</strong>
${status.stale_reason ? `<p>${escape(status.stale_reason)}</p>` : ''}<p>${label(status.working_tree_dirty ? 'Working tree has uncommitted tracked changes.' : 'Working tree has no uncommitted tracked changes.')}</p>
<p>${label('HEAD: {0}', status.head_revision)}</p><p>${label('{0} files, {1} nodes and {2} relationships recorded.', status.files, status.nodes, status.edges)}</p>
<details><summary>${label('Stored Revisions')}</summary><ul>${storedRevisions}</ul></details></div>
<div id="selection" tabindex="-1" data-focus-key="selection"><strong>${label('Selected Symbol')}</strong><p id="selected-symbol">${selected ? escape(selected.qualified_name) : label('No symbol selected. Choose a matching symbol or related endpoint to inspect its recorded relationships.')}</p>
${!selection?.nodeId && selection?.path ? `<p>${label('Path filter: {0}', selection.path)}</p>` : ''}${!selection?.nodeId && selection?.name ? `<p>${label('Name filter: {0}', selection.name)}</p>` : ''}</div></header>
<main id="graph-results" aria-busy="false"><section aria-labelledby="symbols-heading"><h2 id="symbols-heading">${label('Matching Symbols and Nodes')}</h2><p id="node-count">${label('Showing {0} of {1} matching nodes.', page.nodes.length, page.total_nodes)}</p>
${page.nodes.length < page.total_nodes ? `<p class="muted">${label('More matching nodes are recorded than this page shows. Refine the selection to narrow the results.')}</p>` : ''}
<div id="matching-nodes">${page.nodes.length ? page.nodes.map(renderNode).join('') : `<p class="empty">${label('No matching nodes in this page.')}</p>`}</div>
${related.length ? `<details id="related-nodes"><summary>${label('Related Endpoints ({0})', related.length)}</summary><p class="muted">${label('Endpoint metadata provides relationship context; these are not additional matching nodes.')}</p>${related.map(renderNode).join('')}</details>` : ''}</section>
<section aria-labelledby="relationships-heading"><h2 id="relationships-heading">${label('Recorded Relationships')}</h2><p id="edge-count">${label('Showing {0} of {1} relationships.', page.edges.length, page.total_edges)}</p>
<p class="muted">${label('Relationships are bounded independently from matching nodes and may include endpoints outside the matching node page. A recorded call site is one occurrence, not an exhaustive list.')}</p>
${page.edges.length < page.total_edges ? `<p class="muted">${label('More relationships are recorded than this page shows. Refine the selection to narrow the results.')}</p>` : ''}
${page.edges.length ? `<ol class="relationships">${relationships}</ol>` : `<p class="empty">${label('No relationships in this page. This does not prove the symbol has no dependants.')}</p>`}
<p class="muted">${label('Applied list limit: {0}.', page.limit)}</p></section></main>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const version = Number(document.body.dataset.version);
const controls = Array.from(document.querySelectorAll('button,input'));
const disabled = new Map(controls.map(control => [control, control.disabled]));
const progress = document.getElementById('graph-progress');
const resultText = progress.textContent;
let busy = false;
let pendingFocus;
const focusControl = key => {
	const control = Array.from(document.querySelectorAll('[data-focus-key]')).find(element => element.dataset.focusKey === key);
	if (!control) return;
	for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) { if (ancestor instanceof HTMLDetailsElement) ancestor.open = true; }
	control.focus({preventScroll:true});
};
const setBusy = value => {
	busy = value;
	for (const control of controls) control.disabled = value || disabled.get(control);
	document.getElementById('graph-results').setAttribute('aria-busy', String(value));
	progress.textContent = value ? progress.dataset.loading : resultText;
	if (!value && document.activeElement === document.body) focusControl(pendingFocus);
};
const request = (type, values = {}) => {
	if (busy) return;
	pendingFocus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
	const position = {scrollY:window.scrollY, focus:pendingFocus};
	document.getElementById('graph-error').textContent = '';
	api.postMessage({type, ...values, position, version});
	setBusy(true);
};
document.getElementById('graph-query').addEventListener('submit', event => {
	event.preventDefault();
	request('query', {path:document.getElementById('query-path').value, name:document.getElementById('query-name').value});
});
document.addEventListener('click', event => {
	const button = event.target instanceof Element ? event.target.closest('button') : null;
	if (!button || button.disabled) return;
	if (button.dataset.selectId !== undefined) request('select', {nodeId:button.dataset.selectId});
	else if (button.dataset.sourceId !== undefined) request('open', {sourceId:button.dataset.sourceId});
	else if (['refresh','raw','back','reset'].includes(button.dataset.action)) request(button.dataset.action);
});
window.addEventListener('message', event => {
	if (event.origin !== window.origin || !event.data || typeof event.data !== 'object' || event.data.version !== version) return;
	if (event.data.type === 'error' && typeof event.data.error === 'string') { document.getElementById('graph-error').textContent = event.data.error; setBusy(false); }
	else if (event.data.type === 'ready') setBusy(false);
});
if (document.body.dataset.restoreFocus) focusControl(document.body.dataset.restoreFocus);
const scroll = Number(document.body.dataset.restoreScroll);
if (Number.isFinite(scroll) && scroll > 0) window.scrollTo(0, scroll);
</script></body></html>`;
}
