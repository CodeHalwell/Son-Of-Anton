/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { WorkflowCatalog, WorkflowRunSnapshot } from '@codypendent/protocol';
import { WORKFLOW_MAX_INPUT_BYTES, WORKFLOW_MAX_INPUT_FIELDS, WORKFLOW_MAX_TOTAL_INPUT_BYTES } from './workflowInputs.js';

export interface WorkflowPanelState {
	catalog?: WorkflowCatalog;
	catalogRevision: number;
	loading: boolean;
	busy: boolean;
	trusted: boolean;
	error?: string;
	notice?: string;
	runs: Array<{ id: string; workflowId: string; version: number }>;
	selectedRunId?: string;
	snapshot?: WorkflowRunSnapshot;
	snapshotTotalNodes?: number;
	lastReadAt?: string;
	pendingStart?: { workflowId: string };
}

export interface WorkflowViewOptions {
	nonce: string;
	version: number;
	repository: string;
	endpointIdentity: string;
	localize: (text: string, ...args: Array<string | number>) => string;
}

function escapeText(value: string): string {
	return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[character]!));
}

/** Keep a stable form while independent catalog and run snapshots arrive from the host. */
export function renderWorkflowHtml(options: WorkflowViewOptions): string {
	if (!Number.isSafeInteger(options.version) || options.version < 0) { throw new Error(options.localize('Invalid workflow panel version.')); }
	const label = (text: string): string => escapeText(options.localize(text));
	const strings = {
		loading: 'Reading workflow catalog…', catalogUnavailable: 'Workflow catalog unavailable.', empty: 'No workflows were returned for this repository.',
		catalogCount: '{0} workflows returned.', incomplete: 'The catalog is incomplete. Some workflow sources could not be fully inspected.',
		choose: 'Choose a workflow', selected: '{0} · catalog version {1}', builtIn: 'Built In', user: 'User', repository: 'Repository', unknown: 'Unknown',
		metadata: 'Source: {0} · Catalog version: {1} · Declared nodes: {2}', digest: 'Definition Digest: {0}', required: 'Required', optional: 'Optional',
		input: '{0} · Type: {1} · {2}', inputHelp: 'Enter a JSON value. Strings need double quotes; objects, arrays, numbers, booleans and null retain their JSON types.',
		noInputs: 'This workflow declares no inputs.', tooMany: 'This workflow declares {0} inputs. This panel supports at most {1}; Start is unavailable here.', malformedInputs: 'Input declarations are unavailable. Refresh the catalog before starting this workflow.',
		requiredHelp: 'Enter JSON for each required input before starting.', inputBounds: 'Up to {0} inputs, {1} KiB per value and {2} KiB total. Input types are domain names; this panel does not infer a schema or defaults.',
		trust: 'Trust this workspace before starting or controlling a workflow.', pending: 'A Start request for {0} must be reconciled before another workflow is started.',
		working: 'Waiting for the agent runtime…', ready: 'Ready. Starting a workflow may run agents and tools under the runtime’s approval policy.',
		diagnostics: 'Showing {0} of {1} catalog diagnostics.', diagnostic: '{0}: {1}', diagnosticWorkflow: '{0} · {1}: {2}',
		runs: 'Showing {0} of {1} workflow runs started from this panel scope.', noRuns: 'No workflow runs have been opened in this panel scope.',
		run: '{0} · {1} · Requested catalog version: {2}', chooseRun: 'Choose a run', phase: 'Recorded Phase: {0}', readAt: 'Last Snapshot Read: {0}',
		noSnapshot: 'Select a run to read its recorded state.', readingRun: 'Reading the selected workflow run…',
		nodes: 'Showing {0} of {1} recorded nodes.', noNodes: 'The runtime reported no nodes for this run.',
		node: '{0} · {1}', attempt: 'Attempt: {0}', dependencies: 'Depends On: {0}', noDependencies: 'No dependencies recorded.',
		cost: 'Recorded Cost: {0}', unmeasured: 'Unavailable', error: 'Reported Error: {0}', warnings: 'Warnings: {0}',
		retry: 'Retry From This Node', retryLabel: 'Retry from node {0}', selectionUnavailable: 'The workflow selection could not be retained in this webview.',
	};
	const localized = Object.fromEntries(Object.entries(strings).map(([name, text]) => [name, options.localize(text)]));
	const json = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
	const nonce = escapeText(options.nonce);
	return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>${label('Workflows')}</title><style nonce="${nonce}">
body{padding:20px;margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:var(--vscode-font-size,13px) var(--vscode-font-family,system-ui);line-height:1.5}h1{font-size:20px;margin:0}h2{font-size:16px;margin:20px 0 8px}p{margin:6px 0}code,pre{font-family:var(--vscode-editor-font-family,monospace);overflow-wrap:anywhere;white-space:pre-wrap}button,select,textarea{font:inherit;border:1px solid var(--vscode-input-border,transparent);border-radius:3px;box-sizing:border-box}button{padding:5px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.6;cursor:default}select,textarea{padding:6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);max-width:100%;width:100%;min-width:0}textarea{resize:vertical;font-family:var(--vscode-editor-font-family,monospace)}button:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}.toolbar select{flex:1 1 220px;width:auto}.muted{color:var(--vscode-descriptionForeground)}.scope{overflow-wrap:anywhere}.input-field{display:grid;gap:5px;margin:12px 0}.input-field label{font-weight:600}.notice{border-left:3px solid var(--vscode-editorWarning-foreground);padding:8px 12px;background:var(--vscode-textCodeBlock-background)}#workflow-error{color:var(--vscode-errorForeground)}#workflow-error:empty,#workflow-notice:empty{display:none}.node{border:1px solid var(--vscode-panel-border);padding:10px 12px;margin:8px 0;border-radius:4px}.node h3{font-size:14px;margin:0}.nodes{list-style:none;padding:0}.node p{overflow-wrap:anywhere}.node pre{max-height:12em;overflow:auto}.help{max-width:90ch}summary{cursor:pointer}#workflow-progress{min-height:1.5em}.run-actions button{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
</style></head><body data-version="${options.version}">
<header><h1>${label('Workflows')}</h1><p class="scope"><code>${escapeText(options.repository)}</code></p><p class="scope muted">${label('Agent Runtime')}: <code>${escapeText(options.endpointIdentity)}</code></p>
<p class="help muted">${label('Workflow definitions and execution belong to the selected runtime. Starting a workflow is separate from moving a task card.')}</p>
<p id="workflow-progress" role="status" aria-live="polite">${label('Reading workflow catalog…')}</p><p id="workflow-error" role="alert"></p><p id="workflow-notice" role="status" aria-live="polite"></p><p id="workflow-trust" class="notice" hidden></p>
<div id="pending-start" class="notice" hidden><p id="pending-description"></p><button type="button" id="reconcile">${label('Reconcile Start')}</button></div></header>
<main><section aria-labelledby="catalog-heading"><h2 id="catalog-heading">${label('Repository Workflow Catalog')}</h2>
<div class="toolbar"><label for="workflow-catalog">${label('Workflow')}</label><select id="workflow-catalog" disabled></select><button type="button" id="refresh">${label('Refresh Catalog')}</button></div>
<p id="catalog-count" role="status"></p><p id="catalog-incomplete" class="notice" hidden></p><p id="workflow-description"></p><p id="workflow-metadata" class="muted"></p><p id="workflow-digest" class="scope muted"></p>
<form id="workflow-start" aria-describedby="workflow-input-help input-bounds"><p id="workflow-input-help" class="help muted"></p><p id="input-bounds" class="help muted"></p><p class="help muted">${label('Input drafts stay in this panel while it is open. Closing the panel discards unsent values.')}</p><div id="workflow-inputs"></div><p id="input-status" role="status"></p><button type="submit" id="start" disabled>${label('Start Workflow')}</button></form>
<details id="catalog-diagnostics" hidden><summary>${label('Catalog Diagnostics')}</summary><p id="diagnostic-count"></p><ul id="diagnostics"></ul></details></section>
<section id="workflow-monitor" aria-labelledby="runs-heading" aria-busy="false"><h2 id="runs-heading">${label('Workflow Run Monitor')}</h2><p id="run-count"></p>
<div class="toolbar"><label for="workflow-run">${label('Run')}</label><select id="workflow-run" disabled></select><button type="button" id="refresh-run" disabled>${label('Refresh Run')}</button></div>
<p id="run-phase" role="status" aria-live="polite"></p><p id="last-read" class="muted"></p>
<div class="toolbar run-actions"><button type="button" id="pause" disabled>${label('Pause')}</button><button type="button" id="resume" disabled>${label('Resume')}</button><button type="button" id="cancel" disabled>${label('Cancel Workflow')}</button></div>
<p class="help muted">${label('Pause stops new nodes after in-flight work finishes. Cancel is terminal. Retry restarts the chosen node and its downstream dependants. The runtime validates each control request.')}</p>
<p class="help muted">${label('Recorded workflow phases and node states do not establish test success or complete validation. Missing cost measurements remain unavailable.')}</p>
<p id="node-count" role="status"></p><ol id="workflow-nodes" class="nodes"></ol></section></main>
<script nonce="${nonce}">
const api = acquireVsCodeApi();
const version = ${options.version};
const scope = ${json(JSON.stringify([options.endpointIdentity, options.repository]))};
const labels = ${json(localized)};
const limits = {fields:${WORKFLOW_MAX_INPUT_FIELDS},fieldBytes:${WORKFLOW_MAX_INPUT_BYTES},totalBytes:${WORKFLOW_MAX_TOTAL_INPUT_BYTES}};
const byId = id => document.getElementById(id);
const format = (label, ...values) => label.replace(/\\{(\\d+)\\}/g, (_match, index) => String(values[Number(index)] ?? ''));
const text = (id, value) => { const node = byId(id); if (node.textContent !== value) node.textContent = value; };
let state = {catalogRevision:0,loading:true,busy:false,trusted:false,runs:[]};
let selectedWorkflow = '';
let selectedKey = '';
let formSignature = '';
let catalogSignature = '';
let runsSignature = '';
let localPending = false;
let selectionWarning = false;
let drafts = Object.create(null);
try {
	const saved = api.getState?.();
	if (saved && saved.scope === scope) {
		selectedWorkflow = typeof saved.selectedWorkflow === 'string' ? saved.selectedWorkflow : '';
	}
} catch { selectionWarning = true; }
const entry = () => state.catalog?.items.find(item => item.id === selectedWorkflow);
const inputValues = () => Object.fromEntries(Array.from(byId('workflow-inputs').querySelectorAll('textarea')).map(field => [field.dataset.inputName,field.value]));
const persist = () => {
	if (selectedKey) drafts[selectedKey] = inputValues();
	const retained = Object.create(null); let remaining = limits.totalBytes;
	for (const [key, values] of Object.entries(drafts).reverse().sort(([left],[right]) => Number(right === selectedKey) - Number(left === selectedKey))) {
		if (Object.keys(retained).length >= 20) break;
		const bytes = Object.entries(values).reduce((sum,[name,value]) => sum + new TextEncoder().encode(name + value).length,0);
		if (bytes > remaining) continue;
		retained[key] = values; remaining -= bytes;
	}
	drafts = retained;
	try { api.setState?.({scope,selectedWorkflow}); }
	catch { selectionWarning = true; }
};
const canControl = () => state.trusted && !state.busy && !localPending && state.runs.slice(0,20).some(run => run.id === state.selectedRunId);
const updateActions = () => {
	const selected = entry();
	const fields = selected ? Object.entries(selected.inputs) : [];
	const values = inputValues();
	const malformed = fields.some(([,input]) => !input);
	const missing = fields.some(([name,input]) => input?.required && !(Object.hasOwn(values,name) ? values[name] : '').trim());
	const blocked = state.busy || localPending;
	byId('start').disabled = !selected || !state.trusted || blocked || state.loading || !!state.pendingStart || fields.length > limits.fields || malformed || missing;
	byId('refresh').disabled = blocked;
	byId('workflow-catalog').disabled = !state.catalog?.items.length || blocked;
	byId('workflow-run').disabled = !state.runs.length || blocked;
	byId('refresh-run').disabled = !state.selectedRunId || blocked;
	byId('reconcile').disabled = !state.trusted || blocked;
	for (const action of ['pause','resume','cancel']) byId(action).disabled = !canControl();
	for (const button of byId('workflow-nodes').querySelectorAll('button')) button.disabled = !canControl();
	text('input-status', malformed ? labels.malformedInputs : fields.length > limits.fields ? format(labels.tooMany,fields.length,limits.fields) : missing ? labels.requiredHelp : '');
	text('workflow-progress', blocked ? labels.working : state.loading ? labels.loading : !state.catalog ? labels.catalogUnavailable : labels.ready);
	byId('workflow-monitor').setAttribute('aria-busy',String(blocked));
};
const request = (type, values = {}) => {
	if (state.busy || localPending) return;
	persist(); localPending = true; updateActions();
	api.postMessage({type,...values,version});
};
const renderInputs = () => {
	const selected = entry();
	const signature = JSON.stringify(selected ? [selected.id,selected.version,selected.definition_digest,selected.inputs] : null);
	text('workflow-description',selected?.description || '');
	const source = selected ? ({BuiltIn:labels.builtIn,User:labels.user,Repository:labels.repository,Unknown:labels.unknown}[selected.source.type] || labels.unknown) : '';
	text('workflow-metadata',selected ? format(labels.metadata,source,selected.version,selected.node_count) : '');
	text('workflow-digest',selected ? format(labels.digest,selected.definition_digest) : '');
	if (signature === formSignature) return;
	const focused = document.activeElement instanceof HTMLTextAreaElement && byId('workflow-inputs').contains(document.activeElement)
		? {name:document.activeElement.dataset.inputName,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd} : undefined;
	if (selectedKey) persist();
	formSignature = signature;
	selectedKey = selected ? selected.id : '';
	const container = byId('workflow-inputs'); container.replaceChildren();
	const declarations = selected ? Object.entries(selected.inputs) : [];
	text('workflow-input-help',selected ? labels.inputHelp : '');
	text('input-bounds',selected ? format(labels.inputBounds,limits.fields,limits.fieldBytes/1024,limits.totalBytes/1024) : '');
	if (selected && declarations.length <= limits.fields && declarations.every(([,input]) => !!input)) {
		for (const [index,[name,input]] of declarations.entries()) {
			const wrapper = document.createElement('div'), label = document.createElement('label'), field = document.createElement('textarea');
			wrapper.className = 'input-field'; field.id = 'workflow-input-' + index; label.htmlFor = field.id;
			label.textContent = format(labels.input,name,input.input_type,input.required ? labels.required : labels.optional);
			field.dataset.inputName = name; field.dataset.focusKey = 'input:' + name; field.rows = 3; field.maxLength = limits.fieldBytes; field.required = input.required;
			field.setAttribute('aria-describedby','workflow-input-help input-bounds');
			field.value = Object.hasOwn(drafts,selectedKey) && Object.hasOwn(drafts[selectedKey],name) ? drafts[selectedKey][name] : '';
			field.addEventListener('input',() => { persist(); updateActions(); });
			wrapper.append(label,field); container.append(wrapper);
		}
		if (!declarations.length) { const note = document.createElement('p'); note.textContent = labels.noInputs; container.append(note); }
	}
	if (focused) {
		const field = Array.from(container.querySelectorAll('textarea')).find(item => item.dataset.inputName === focused.name);
		if (field) { field.focus({preventScroll:true}); field.setSelectionRange(focused.start,focused.end); }
	}
};
const renderCatalog = () => {
	const items = state.catalog?.items || [];
	const signature = JSON.stringify(items.map(item => [item.id,item.version,item.definition_digest]));
	if (signature !== catalogSignature) {
		catalogSignature = signature;
		const select = byId('workflow-catalog'); select.replaceChildren();
		if (state.catalog && !items.some(item => item.id === selectedWorkflow)) selectedWorkflow = items[0]?.id || '';
		if (!items.length) { const option = document.createElement('option'); option.textContent = labels.choose; select.append(option); }
		for (const item of items) { const option = document.createElement('option'); option.value = item.id; option.textContent = format(labels.selected,item.id,item.version); select.append(option); }
		select.value = selectedWorkflow;
	}
	text('catalog-count',!state.catalog ? '' : items.length ? format(labels.catalogCount,items.length) : labels.empty);
	byId('catalog-incomplete').hidden = !state.catalog?.truncated; text('catalog-incomplete',labels.incomplete);
	const diagnostics = state.catalog?.diagnostics || [];
	byId('catalog-diagnostics').hidden = !diagnostics.length;
	text('diagnostic-count',format(labels.diagnostics,Math.min(100,diagnostics.length),diagnostics.length));
	const list = byId('diagnostics'); list.replaceChildren();
	for (const item of diagnostics.slice(0,100)) { const row = document.createElement('li'); row.textContent = item.workflow_id ? format(labels.diagnosticWorkflow,item.workflow_id,item.code,item.message) : format(labels.diagnostic,item.code,item.message); list.append(row); }
	renderInputs();
};
const renderRuns = () => {
	const runs = state.runs.slice(0,20);
	const signature = JSON.stringify(runs);
	if (signature !== runsSignature) {
		runsSignature = signature;
		const select = byId('workflow-run'); select.replaceChildren();
		if (!runs.length) { const option = document.createElement('option'); option.textContent = labels.chooseRun; select.append(option); }
		for (const run of runs) { const option = document.createElement('option'); option.value = run.id; option.textContent = format(labels.run,run.workflowId,run.id,run.version); select.append(option); }
	}
	byId('workflow-run').value = state.selectedRunId || '';
	text('run-count',runs.length ? format(labels.runs,runs.length,state.runs.length) : labels.noRuns);
	const snapshot = state.snapshot?.workflow_run_id === state.selectedRunId ? state.snapshot : undefined;
	text('run-phase',snapshot ? format(labels.phase,snapshot.phase.type) : state.selectedRunId ? labels.readingRun : labels.noSnapshot);
	text('last-read',snapshot && state.lastReadAt ? format(labels.readAt,state.lastReadAt) : '');
	const nodes = snapshot?.nodes.slice(0,100) || [];
	text('node-count',snapshot ? format(labels.nodes,nodes.length,state.snapshotTotalNodes ?? snapshot.nodes.length) : '');
	const container = byId('workflow-nodes');
	const existing = new Map(Array.from(container.children).map(row => [row.dataset.nodeId,row]));
	const keep = new Set();
	for (const node of nodes) {
		keep.add(node.node_id);
		let row = existing.get(node.node_id);
		if (!row) {
			row = document.createElement('li'); row.className = 'node'; row.dataset.nodeId = node.node_id;
			for (const name of ['heading','attempt','dependencies','cost','error','warnings']) { const part = document.createElement(name === 'heading' ? 'h3' : name === 'error' || name === 'warnings' ? 'pre' : 'p'); part.dataset.part = name; row.append(part); }
			const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = labels.retry; retry.dataset.nodeId = node.node_id; retry.dataset.focusKey = 'retry:' + node.node_id;
			retry.addEventListener('click',() => { if (canControl()) request('retry',{runId:state.selectedRunId,nodeId:node.node_id}); }); row.append(retry); container.append(row);
		}
		const part = (name,value) => { const element = row.querySelector('[data-part="' + name + '"]'); if (element.textContent !== value) element.textContent = value; };
		part('heading',format(labels.node,node.node_id,node.state.type)); part('attempt',format(labels.attempt,node.attempt));
		part('dependencies',node.depends_on?.length ? format(labels.dependencies,node.depends_on.join(', ')) : labels.noDependencies);
		part('cost',format(labels.cost,node.cost === undefined || node.cost === null ? labels.unmeasured : JSON.stringify(node.cost)));
		part('error',node.error ? format(labels.error,node.error) : ''); part('warnings',node.warnings?.length ? format(labels.warnings,node.warnings.join(' · ')) : '');
		row.querySelector('button').setAttribute('aria-label',format(labels.retryLabel,node.node_id));
	}
	for (const [id,row] of existing) if (!keep.has(id)) row.remove();
	if (snapshot && !nodes.length) { const empty = document.createElement('li'); empty.textContent = labels.noNodes; container.replaceChildren(empty); }
};
byId('workflow-catalog').addEventListener('change',() => { persist(); selectedWorkflow = byId('workflow-catalog').value; renderInputs(); persist(); updateActions(); });
byId('workflow-start').addEventListener('submit',event => { event.preventDefault(); if (!byId('start').disabled) request('start',{workflowId:selectedWorkflow,inputValues:inputValues(),catalogRevision:state.catalogRevision}); });
byId('refresh').addEventListener('click',() => request('refresh'));
byId('workflow-run').addEventListener('change',() => request('selectRun',{runId:byId('workflow-run').value}));
byId('refresh-run').addEventListener('click',() => request('refreshRun'));
byId('reconcile').addEventListener('click',() => { if (state.trusted && state.pendingStart) request('reconcile'); });
for (const action of ['pause','resume','cancel']) byId(action).addEventListener('click',() => { if (canControl()) request(action,{runId:state.selectedRunId}); });
window.addEventListener('message',event => {
	if (event.origin !== window.origin || !event.data || event.data.type !== 'state' || event.data.version !== version || !event.data.state || typeof event.data.state !== 'object') return;
	state = event.data.state; localPending = false;
	text('workflow-error',state.error || ''); text('workflow-notice',state.notice || (selectionWarning ? labels.selectionUnavailable : ''));
	byId('workflow-trust').hidden = state.trusted; text('workflow-trust',labels.trust);
	byId('pending-start').hidden = !state.pendingStart; text('pending-description',state.pendingStart ? format(labels.pending,state.pendingStart.workflowId) : '');
	renderCatalog(); renderRuns(); updateActions();
});
persist(); api.postMessage({type:'ready',version});
</script></body></html>`;
}
