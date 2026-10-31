/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderGraphHtml, renderGraphLoadingHtml, type GraphViewOptions } from '../src/graphView.js';

interface GraphMessage { type: string; version: number; nodeId?: string; sourceId?: string; path?: string; name?: string; position: { scrollY: number; focus?: string } }

const windows: JSDOM[] = [];
afterEach(() => { for (const dom of windows.splice(0)) { dom.window.close(); } });

function fixture(): GraphViewOptions {
	return {
		nonce: 'graph-fixture', version: 7, repository: '/workspace/repository',
		selection: { path: 'src/source.ts', name: 'selected', nodeId: 'selected-id' },
		localize: (text, ...args) => text.replace(/\{(\d+)\}/g, (_match, index: string) => String(args[Number(index)] ?? '')),
		status: {
			repository_root: '/workspace/repository', head_revision: 'head-revision', files: 4, nodes: 14, edges: 22,
			stale: true, stale_reason: 'Tracked source changed since indexing.', working_tree_dirty: true,
			revisions: [{ label: 'saved-revision', count: 14 }], by_language: [], by_kind: [],
		},
		page: {
			limit: 1, total_nodes: 9, total_edges: 8,
			nodes: [{ id: 'selected-id', qualified_name: 'source.selected', kind: 'function', language: 'typescript', revision: 'saved-revision', source_path: 'src/source.ts', location: { source_path: 'src/source.ts', line: 5, column: 2 } }],
			related_nodes: [{ id: 'caller-id', qualified_name: 'other.caller', kind: 'function', language: 'typescript', revision: 'saved-revision', source_path: 'src/caller.ts' }],
			edges: [{ from_id: 'caller-id', from_name: 'other.caller', to_id: 'selected-id', to_name: 'source.selected', relation: 'calls', confidence: 0.875, evidence_kind: 'agent_asserted', revision: 'edge-revision', call_site: { source_path: 'src/caller.ts', line: 11, column: 4 }, asserted_by: { session_id: 'asserting-session', run_id: 'asserting-run', rationale: 'The caller records this relationship.' } }],
		},
	};
}

function mount(options = fixture()) {
	const html = renderGraphHtml(options);
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://graph.fixture/' });
	windows.push(dom);
	const sent: GraphMessage[] = [];
	const scrollTo = vi.fn();
	Object.assign(dom.window, { acquireVsCodeApi: () => ({ postMessage: (message: GraphMessage) => sent.push(message) }), scrollTo });
	dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
	const click = (selector: string): void => { dom.window.document.querySelector<HTMLButtonElement>(selector)!.click(); };
	const receive = (type: string, extra = {}): void => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { origin: dom.window.origin, data: { type, version: options.version, ...extra } })); };
	return { dom, document: dom.window.document, sent, html, click, receive, scrollTo };
}

describe('recorded code graph inspector', () => {
	it('renders malicious graph labels and provenance as text under a nonce CSP', () => {
		const options = fixture();
		const hostile = '</script><img src=x onerror="bad()"><svg onload="bad()">';
		options.repository = hostile;
		options.page.nodes[0].id = 'selected" autofocus onfocus="bad()';
		options.selection!.nodeId = options.page.nodes[0].id;
		options.page.edges[0].to_id = options.page.nodes[0].id;
		options.page.nodes[0].qualified_name = hostile;
		options.page.nodes[0].source_path = hostile;
		options.page.nodes[0].location!.source_path = hostile;
		options.page.edges[0].from_name = hostile;
		options.page.edges[0].asserted_by!.rationale = hostile;
		options.status.stale_reason = hostile;
		const view = mount(options);
		expect(view.document.querySelectorAll('img, svg, [onerror], [onload], [onfocus], [autofocus]')).toHaveLength(0);
		expect(view.document.querySelectorAll('script')).toHaveLength(1);
		expect(view.document.body.textContent).toContain(hostile);
			expect(view.html).toContain('default-src \'none\'; style-src \'nonce-graph-fixture\'; script-src \'nonce-graph-fixture\'');
		expect(view.document.querySelector('style')!.getAttribute('nonce')).toBe('graph-fixture');
	});

	it('keeps independent totals, contextual endpoints and recorded freshness visible', () => {
		const view = mount();
		expect(view.document.querySelector('#node-count')!.textContent).toBe('Showing 1 of 9 matching nodes.');
		expect(view.document.querySelector('#edge-count')!.textContent).toBe('Showing 1 of 8 relationships.');
		expect(view.document.querySelectorAll('#matching-nodes [data-node-id]')).toHaveLength(1);
		expect(view.document.querySelector('#related-nodes')!.textContent).toContain('not additional matching nodes');
		expect(view.document.querySelector('#selected-symbol')!.textContent).toBe('source.selected');
		for (const evidence of ['Saved Graph Is Stale', 'Tracked source changed since indexing.', 'uncommitted tracked changes', 'head-revision', 'saved-revision', '14 nodes', 'complete impact or measured test coverage']) {
			expect(view.document.body.textContent).toContain(evidence);
		}
	});

	it('shows direction, evidence confidence, call occurrence and assertion audit trail', () => {
		const view = mount();
		const relation = view.document.querySelector('.relationship')!;
		for (const evidence of ['Incoming', 'other.caller', 'source.selected', 'calls', 'agent_asserted', '87.5%', 'edge-revision', 'src/caller.ts:11:4', 'asserting-session', 'asserting-run', 'The caller records this relationship.']) {
			expect(relation.textContent).toContain(evidence);
		}
		expect(view.document.body.textContent).toContain('one occurrence, not an exhaustive list');
	});

	it('sends only versioned graph identities when selecting, opening or refreshing', () => {
		const view = mount();
		for (const selector of ['#matching-nodes [data-select-id]', '#related-nodes [data-select-id]', '#matching-nodes [data-source-id]', '.relationship [data-source-id]', '[data-action="refresh"]', '[data-action="raw"]']) {
			view.click(selector); view.receive('ready');
		}
		expect(view.sent.map(({ position, ...message }) => message)).toEqual([
			{ type: 'select', nodeId: 'selected-id', version: 7 }, { type: 'select', nodeId: 'caller-id', version: 7 },
			{ type: 'open', sourceId: 'node:selected-id', version: 7 }, { type: 'open', sourceId: 'edge:0', version: 7 },
			{ type: 'refresh', version: 7 }, { type: 'raw', version: 7 },
		]);
		expect(JSON.stringify(view.sent)).not.toContain('src/');
		expect(view.document.querySelector('#related-nodes [data-source-id]')!.textContent).toBe('Open File');
	});

	it('submits filters, announces loading and prevents duplicate queries until the host replies', () => {
		const view = mount();
		const path = view.document.querySelector<HTMLInputElement>('#query-path')!;
		const name = view.document.querySelector<HTMLInputElement>('#query-name')!;
		expect([path.value, name.value]).toEqual(['src/source.ts', 'selected']);
		expect(view.document.querySelector('label[for="query-path"]')!.textContent).toBe('Path Prefix');
		path.value = 'src/new/'; name.value = '<new.symbol>'; name.focus();
		const submit = (): void => { view.document.querySelector('form')!.dispatchEvent(new view.dom.window.Event('submit', { bubbles: true, cancelable: true })); };
		submit(); submit(); view.click('[data-action="refresh"]');
		expect(view.sent).toEqual([{ type: 'query', path: 'src/new/', name: '<new.symbol>', position: { scrollY: 0, focus: 'query-name' }, version: 7 }]);
		expect(view.document.querySelector('#graph-results')!.getAttribute('aria-busy')).toBe('true');
		expect(view.document.querySelector('#graph-progress')!.textContent).toBe('Loading recorded graph…');
		view.receive('error', { error: 'Temporary read failure' });
		expect([path.disabled, name.disabled, name.value, view.document.querySelector('#graph-results')!.getAttribute('aria-busy'), view.document.querySelector<HTMLButtonElement>('[data-action="back"]')!.disabled]).toEqual([false, false, '<new.symbol>', 'false', true]);
		submit(); expect(view.sent).toHaveLength(2);
	});

	it('offers Back and repository overview without exposing source paths as navigation targets', () => {
		const options = fixture(); options.canGoBack = true;
		const view = mount(options);
		view.click('[data-action="back"]'); view.receive('ready');
		view.click('[data-action="reset"]');
		expect(view.sent.map(message => message.type)).toEqual(['back', 'reset']);
		expect(view.sent.every(message => message.version === 7 && message.path === undefined && message.nodeId === undefined)).toBe(true);
	});

	it('restores keyboard focus and scroll for a previous browsing view', () => {
		const options = fixture(); options.position = { scrollY: 480, focus: 'select:caller-id' };
		const view = mount(options);
		expect(view.document.activeElement?.getAttribute('data-select-id')).toBe('caller-id');
		expect(view.document.querySelector<HTMLDetailsElement>('#related-nodes')!.open).toBe(true);
		expect(view.scrollTo).toHaveBeenCalledWith(0, 480);
	});

	it('restores the exact relationship control when a symbol also appears in the result list', () => {
		const options = fixture(); options.position = { scrollY: 800, focus: 'relation:0:to' };
		const view = mount(options);
		expect(view.document.activeElement?.getAttribute('data-focus-key')).toBe('relation:0:to');
		expect(view.document.activeElement?.closest('.relationship')).not.toBeNull();
	});

	it('shows escaped initial connection progress without scripts or filesystem capabilities', () => {
		const options = fixture();
		const dom = new JSDOM(renderGraphLoadingHtml('<img src=x onerror=bad()>', options.localize)); windows.push(dom);
		expect(dom.window.document.querySelector('[role="status"]')!.textContent).toBe('Loading recorded graph…');
		expect(dom.window.document.querySelectorAll('img, script')).toHaveLength(0);
		expect(dom.window.document.querySelector('code')!.textContent).toBe('<img src=x onerror=bad()>');
	});

	it('does not invent a selected symbol, source location or call site', () => {
		const options = fixture();
		options.selection = { name: 'substring-only' };
		options.page.nodes[0].location = undefined;
		options.page.nodes[0].source_path = undefined;
		options.page.edges[0].call_site = undefined;
		options.status.stale = false; options.status.stale_reason = undefined; options.status.working_tree_dirty = false;
		const view = mount(options);
		expect(view.document.querySelector('#selected-symbol')!.textContent).toContain('No symbol selected.');
		expect(view.document.querySelector('#matching-nodes [data-source-id]')).toBeNull();
		expect(view.document.querySelector('.relationship [data-source-id]')).toBeNull();
		expect(view.document.querySelector('.relationship')!.textContent).toContain('Call site unavailable.');
		expect(view.document.body.textContent).toContain('Saved Graph Is Current');
		expect(view.document.body.textContent).toContain('Working tree has no uncommitted tracked changes.');
	});

	it('ignores foreign-origin and obsolete errors and renders current errors as text', () => {
		const view = mount();
		const receive = (version: number, origin: string): void => { view.dom.window.dispatchEvent(new view.dom.window.MessageEvent('message', { origin, data: { type: 'error', error: '<img onerror="bad()">', version } })); };
		receive(7, 'https://foreign.fixture'); receive(6, view.dom.window.origin);
		expect(view.document.querySelector('#graph-error')!.textContent).toBe('');
		receive(7, view.dom.window.origin);
		expect(view.document.querySelector('#graph-error')!.textContent).toBe('<img onerror="bad()">');
		expect(view.document.querySelector('#graph-error img')).toBeNull();
	});
});
