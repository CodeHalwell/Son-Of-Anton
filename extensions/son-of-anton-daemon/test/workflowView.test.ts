/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWorkflowHtml, type WorkflowPanelState, type WorkflowViewOptions } from '../src/workflowView.js';

interface Message { type: string; version: number; workflowId?: string; inputValues?: Record<string, string>; catalogRevision?: number; runId?: string; nodeId?: string }
const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) { dom.window.close(); } });

function fixture(): WorkflowPanelState {
	return {
		catalogRevision: 3, loading: false, busy: false, trusted: true,
		catalog: {
			repository: '/repository', truncated: false, diagnostics: [],
			items: [{ id: 'review-pr', version: 2, definition_digest: 'a'.repeat(64), description: 'Review a pull request', node_count: 2, source: { type: 'Repository' }, inputs: { pull_request: { input_type: 'github_pull_request', required: true }, extra: { input_type: 'opaque', required: false } } }],
		},
		runs: [{ id: 'run-a', workflowId: 'review-pr', version: 2 }], selectedRunId: 'run-a', lastReadAt: '2026-10-31T10:00:00Z',
		snapshot: { workflow_run_id: 'run-a', phase: { type: 'Failed' }, nodes: [
			{ workflow_run_id: 'run-a', node_id: 'inspect', state: { type: 'Completed' }, attempt: 1, cost: 0 },
			{ workflow_run_id: 'run-a', node_id: 'review', state: { type: 'Failed' }, attempt: 2, depends_on: ['inspect'], error: 'A provider refused this request', warnings: ['Budget warning'] },
		] },
	};
}

function mount(saved?: unknown, overrides: Partial<WorkflowViewOptions> = {}) {
	const options: WorkflowViewOptions = {
		nonce: 'workflow-fixture', version: 17, repository: '/repository', endpointIdentity: 'private-anton',
		// VS Code format2 preserves placeholders when no matching argument is supplied.
		localize: (text, ...values) => text.replace(/\{(\d+)\}/g, (match, index: string) => String(values[Number(index)] ?? match)), ...overrides,
	};
	const html = renderWorkflowHtml(options);
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://workflow.fixture/' }); windows.push(dom);
	const sent: Message[] = [];
	const setState = vi.fn();
	Object.assign(dom.window, { TextEncoder, acquireVsCodeApi: () => ({ postMessage: (message: Message) => sent.push(message), getState: () => saved, setState }) });
	dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
	const document = dom.window.document;
	const publish = (state: WorkflowPanelState, version = options.version, origin = dom.window.origin): void => {
		dom.window.dispatchEvent(new dom.window.MessageEvent('message', { origin, data: { type: 'state', version, state } }));
	};
	const field = (): HTMLTextAreaElement => document.querySelector<HTMLTextAreaElement>('#workflow-input-0')!;
	const input = (value: string): void => { field().value = value; field().dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
	const click = (id: string): void => document.querySelector<HTMLButtonElement>('#' + id)!.click();
	return { dom, document, html, sent, setState, publish, field, input, click, options };
}

describe('repository workflow panel', () => {
	it('renders catalog provenance, diagnostics and snapshot evidence as text under a nonce CSP', () => {
		const hostile = '</script><img src=x onerror="bad()"><svg onload="bad()">';
		const view = mount(undefined, { repository: hostile, endpointIdentity: hostile, localize: text => text === 'Workflows' ? hostile : text });
		const state = fixture();
		state.catalog!.items[0].id = hostile;
		state.catalog!.items[0].description = hostile;
		state.catalog!.items[0].definition_digest = hostile;
		state.catalog!.items[0].inputs = { [hostile]: { input_type: hostile, required: true } };
		state.catalog!.diagnostics = [{ code: hostile, message: hostile, workflow_id: hostile }];
		state.snapshot!.nodes[0].error = hostile; state.snapshot!.nodes[0].warnings = [hostile]; state.snapshot!.nodes[0].cost = { evidence: hostile };
		state.error = hostile; state.notice = hostile;
		view.publish(state);
		expect(view.document.querySelectorAll('script')).toHaveLength(1);
		expect(view.document.querySelectorAll('img,svg,[onerror],[onload]')).toHaveLength(0);
		expect(view.document.body.textContent).toContain(hostile);
		expect(view.document.querySelector('#workflow-input-0')!.getAttribute('required')).toBe('');
		expect(view.html).toContain("default-src 'none'; style-src 'nonce-workflow-fixture'; script-src 'nonce-workflow-fixture'");
		expect(view.document.querySelector('style')!.getAttribute('nonce')).toBe('workflow-fixture');
	});

	it('keeps focused JSON inputs, selection, drafts and monitor controls stable across polling', () => {
		const view = mount(); const state = fixture(); view.publish(state);
		view.input('{"url":"https://example.test/pr/1"}');
		const field = view.field(); field.focus(); field.setSelectionRange(2, 7);
		const refreshed = fixture(); refreshed.catalogRevision++; refreshed.snapshot!.nodes[1].attempt++;
		view.publish(refreshed);
		expect(view.field()).toBe(field);
		expect([view.document.activeElement, field.selectionStart, field.selectionEnd, field.value]).toEqual([field, 2, 7, '{"url":"https://example.test/pr/1"}']);
		const retry = view.document.querySelector<HTMLButtonElement>('[data-focus-key="retry:review"]')!; retry.focus();
		view.publish({ ...refreshed, snapshot: { ...refreshed.snapshot!, phase: { type: 'Paused' } } });
		expect(view.document.activeElement).toBe(retry);
		expect(view.document.querySelector('#run-phase')!.textContent).toBe('Recorded Phase: Paused');
		expect(view.setState.mock.calls.at(-1)?.[0]).toMatchObject({ scope: JSON.stringify(['private-anton', '/repository']), selectedWorkflow: 'review-pr' });
		expect(JSON.stringify(view.setState.mock.calls)).not.toContain('https://example.test/pr/1');
		expect(view.sent).toEqual([{ type: 'ready', version: 17 }]);
	});

	it('sends explicit versioned Start and allowlisted controls without automatically replaying writes', () => {
		const view = mount(); const state = fixture(); view.publish(state);
		view.input('{"number":123}');
		view.field().dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		expect(view.sent).toHaveLength(1);
		view.click('start'); view.click('start');
		expect(view.sent.at(-1)).toEqual({ type: 'start', workflowId: 'review-pr', inputValues: { pull_request: '{"number":123}', extra: '' }, catalogRevision: 3, version: 17 });
		expect(view.sent.filter(message => message.type === 'start')).toHaveLength(1);
		for (const action of ['refresh', 'refresh-run', 'pause', 'resume', 'cancel']) { view.publish(state); view.click(action); }
		view.publish(state); view.document.querySelector<HTMLButtonElement>('[data-focus-key="retry:review"]')!.click();
		view.publish({ ...state, pendingStart: { workflowId: 'review-pr' } });
		expect(view.document.querySelector<HTMLButtonElement>('#start')!.disabled).toBe(true);
		view.click('cancel');
		view.publish({ ...state, pendingStart: { workflowId: 'review-pr' } });
		view.click('reconcile'); view.click('reconcile');
		expect(view.sent.slice(2)).toEqual([
			{ type: 'refresh', version: 17 }, { type: 'refreshRun', version: 17 },
			{ type: 'pause', runId: 'run-a', version: 17 }, { type: 'resume', runId: 'run-a', version: 17 }, { type: 'cancel', runId: 'run-a', version: 17 },
			{ type: 'retry', runId: 'run-a', nodeId: 'review', version: 17 }, { type: 'cancel', runId: 'run-a', version: 17 }, { type: 'reconcile', version: 17 },
		]);
		expect(JSON.stringify(view.sent)).not.toContain('/repository');
	});

	it('keeps catalog reads available without trust and refuses Start and controls without a scoped receipt', () => {
		const view = mount(); const state = fixture();
		view.publish({ ...state, trusted: false, pendingStart: { workflowId: 'review-pr' } }); view.input('null');
		for (const action of ['start', 'pause', 'resume', 'cancel', 'reconcile']) view.click(action);
		view.document.querySelector<HTMLButtonElement>('[data-focus-key="retry:review"]')!.click();
		expect(view.sent).toEqual([{ type: 'ready', version: 17 }]);
		expect(view.document.querySelector<HTMLElement>('#workflow-trust')!.hidden).toBe(false);
		view.click('refresh'); expect(view.sent.at(-1)).toEqual({ type: 'refresh', version: 17 });
		view.publish({ ...state, runs: [], selectedRunId: 'unlisted-run' });
		view.click('cancel'); expect(view.sent).toHaveLength(2);
	});

	it('shows independent bounded counts and recorded unknown measurements without success claims', () => {
		const view = mount(); const state = fixture();
		state.runs = Array.from({ length: 25 }, (_, index) => ({ id: `run-${index}`, workflowId: 'review-pr', version: 2 })); state.selectedRunId = 'run-0';
		state.snapshot = { workflow_run_id: 'run-0', phase: { type: 'Completed' }, nodes: Array.from({ length: 120 }, (_, index) => ({ workflow_run_id: 'run-0', node_id: `node-${index}`, state: { type: 'Unknown' }, attempt: 0, cost: index === 0 ? 0 : undefined })) };
		state.snapshotTotalNodes = 200;
		state.catalog!.truncated = true; state.catalog!.diagnostics = Array.from({ length: 150 }, (_, index) => ({ code: `diagnostic-${index}`, message: 'A source was unavailable' }));
		view.publish(state);
		expect(view.document.querySelectorAll('#workflow-nodes .node')).toHaveLength(100);
		expect(view.document.querySelector('#node-count')!.textContent).toBe('Showing 100 of 200 recorded nodes.');
		expect(view.document.querySelectorAll('#workflow-run option')).toHaveLength(20);
		expect(view.document.querySelector('#run-count')!.textContent).toContain('Showing 20 of 25');
		expect(view.document.querySelectorAll('#diagnostics li')).toHaveLength(100);
		expect(view.document.querySelector('#diagnostic-count')!.textContent).toBe('Showing 100 of 150 catalog diagnostics.');
		for (const evidence of ['Source: Repository', 'Catalog version: 2', 'Definition Digest: ' + 'a'.repeat(64), 'Requested catalog version: 2', 'Recorded Cost: 0', 'Recorded Cost: Unavailable', 'Last Snapshot Read:', 'do not establish test success', 'catalog is incomplete']) expect(view.document.querySelector('main')!.textContent).toContain(evidence);
	});

	it('distinguishes unavailable catalogs, empty catalogs and schemas too large to launch', () => {
		const view = mount(); const state = fixture();
		view.publish({ ...state, catalog: undefined, error: 'This runtime does not support workflow catalogs.' });
		expect(view.document.querySelector('#workflow-progress')!.textContent).toBe('Workflow catalog unavailable.');
		expect(view.document.querySelector('#catalog-count')!.textContent).toBe('');
		expect(view.document.querySelector('#workflow-error')!.textContent).toBe('This runtime does not support workflow catalogs.');
		view.publish({ ...state, catalog: { ...state.catalog!, items: [] } });
		expect(view.document.querySelector('#catalog-count')!.textContent).toBe('No workflows were returned for this repository.');
		state.catalog!.items[0].inputs = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`input-${index}`, { input_type: 'opaque', required: true }]));
		view.publish(state);
		expect(view.document.querySelector('#input-status')!.textContent).toContain('declares 65 inputs');
		expect(view.document.querySelectorAll('textarea')).toHaveLength(0);
		expect(view.document.querySelector<HTMLButtonElement>('#start')!.disabled).toBe(true);
	});

	it('retains matching raw fields in memory through definition changes and persists only scoped selection metadata', () => {
		const view = mount(); const state = fixture();
		state.catalog!.items.push({ ...state.catalog!.items[0], id: 'another-workflow' });
		view.publish(state); view.input('false');
		const select = view.document.querySelector<HTMLSelectElement>('#workflow-catalog')!;
		select.value = 'another-workflow'; select.dispatchEvent(new view.dom.window.Event('change'));
		expect(view.field().value).toBe(''); view.input('0');
		select.value = 'review-pr'; select.dispatchEvent(new view.dom.window.Event('change'));
		expect(view.field().value).toBe('false');
		const saved = view.setState.mock.calls.at(-1)![0];
		expect(saved).toEqual({ scope: JSON.stringify(['private-anton', '/repository']), selectedWorkflow: 'review-pr' });
		const reopened = mount({ ...saved, drafts: { 'review-pr': { pull_request: '"private-legacy-marker"' } } });
		reopened.publish(state); expect(reopened.field().value).toBe('');
		expect(JSON.stringify(reopened.setState.mock.calls)).not.toContain('private-legacy-marker');
		const external = mount(saved, { endpointIdentity: 'external-runtime' }); external.publish(state); expect(external.field().value).toBe('');
		const otherRepository = mount(saved, { repository: '/another-repository' }); otherRepository.publish(state); expect(otherRepository.field().value).toBe('');
		const changed = fixture(); changed.catalogRevision++; changed.catalog!.items[0].version++; changed.catalog!.items[0].definition_digest = 'b'.repeat(64);
		changed.catalog!.items[0].inputs = { pull_request: { input_type: 'github_pull_request', required: true }, new_input: { input_type: 'opaque', required: false } };
		view.field().focus(); view.field().setSelectionRange(1,3);
		view.publish(changed);
		expect([view.field().value,view.document.activeElement,view.field().selectionStart,view.field().selectionEnd]).toEqual(['false',view.field(),1,3]);
		expect(view.document.querySelector<HTMLTextAreaElement>('#workflow-input-1')!.value).toBe('');
		expect(view.document.querySelector('#workflow-digest')!.textContent).toContain('b'.repeat(64));
		expect(view.sent).toEqual([{ type: 'ready', version: 17 }]);
		view.click('start');
		expect(view.sent.at(-1)).toEqual({ type: 'start', workflowId: 'review-pr', catalogRevision: 4, inputValues: { pull_request: 'false', new_input: '' }, version: 17 });
	});

	it('ignores obsolete and foreign host messages and offers explicit reconciliation without replaying Start', () => {
		const view = mount(); const state = fixture(); view.publish(state); view.input('true');
		view.publish({ ...state, error: 'obsolete' }, 16);
		view.publish({ ...state, error: 'foreign' }, 17, 'https://foreign.fixture');
		expect(view.document.querySelector('#workflow-error')!.textContent).toBe('');
		view.publish({ ...state, pendingStart: { workflowId: 'review-pr' } });
		expect(view.document.querySelector('#pending-description')!.textContent).toBe('A Start request for review-pr must be reconciled before another workflow is started.');
		expect(view.sent).toEqual([{ type: 'ready', version: 17 }]);
		view.click('reconcile');
		expect(view.sent.at(-1)).toEqual({ type: 'reconcile', version: 17 });
	});
});
