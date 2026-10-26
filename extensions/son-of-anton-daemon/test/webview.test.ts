/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderSessionHtml } from '../src/html.js';
import type { SharedSessionState } from '../src/session.js';

let script: string;
const windows: JSDOM[] = [];
beforeAll(async () => {
	const result = await build({ entryPoints: [fileURLToPath(new URL('../src/webview.ts', import.meta.url))],
		bundle: true, write: false, platform: 'browser', format: 'iife' });
	script = result.outputFiles[0].text;
});
afterEach(() => { for (const dom of windows.splice(0)) { dom.window.close(); } });

function mount() {
	const html = renderSessionHtml({ nonce: 'fixture-nonce', script: 'https://fixture/webview.js',
		style: 'https://fixture/session.css', cspSource: 'https://fixture', localize: text => text });
	const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://fixture/' });
	windows.push(dom);
	const sent: Array<Record<string, string>> = [];
	let saved: object = {};
	Object.assign(dom.window, { acquireVsCodeApi: () => ({ postMessage: (message: Record<string, string>) => sent.push(message),
		getState: () => saved, setState: (state: object) => { saved = state; } }) });
	dom.window.eval(script);
	const state: SharedSessionState = { status: 'attached', sessionId: '11111111-1111-1111-1111-111111111111',
		projection: { title: 'Shared session', rows: [], activeRuns: [], approvals: [], questions: [], historyTruncated: false } };
	const receive = (message: object): void => { dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })); };
	const update = (trusted = true): void => receive({ type: 'state', trusted, library: [], state, error: '' });
	return { dom, sent, state, update, receive, html };
}

describe('shared session webview', () => {
	it('preserves a draft after rejection and clears it only after its own accepted submission', () => {
		const view = mount(); view.update();
		const draft = view.dom.window.document.querySelector('textarea')!;
		const form = view.dom.window.document.querySelector('form')!;
		draft.value = 'Keep this prompt';
		form.dispatchEvent(new view.dom.window.Event('submit', { cancelable: true }));
		const first = view.sent.at(-1)!;
		expect(first.type).toBe('submit');
		view.receive({ type: 'submitted', requestId: first.requestId, accepted: false });
		expect(draft.value).toBe('Keep this prompt');
		form.dispatchEvent(new view.dom.window.Event('submit', { cancelable: true }));
		view.receive({ type: 'submitted', requestId: first.requestId, accepted: true });
		expect(draft.value).toBe('Keep this prompt');
		view.receive({ type: 'submitted', requestId: view.sent.at(-1)!.requestId, accepted: true });
		expect(draft.value).toBe('');
	});

	it('renders provider text without interpreting HTML under a restrictive CSP', () => {
		const view = mount();
		view.state.projection.rows = [{ id: 'x', kind: 'assistant', text: '<img src=x onerror="bad()">' }];
		view.update();
		expect(view.dom.window.document.querySelector('#transcript img')).toBeNull();
		expect(view.dom.window.document.querySelector('#transcript')!.textContent).toContain('<img');
		expect(view.html).toContain("default-src 'none'");
		expect(view.html).toContain("script-src 'nonce-fixture-nonce'");
	});

	it('disables prompts and approvals while untrusted or disconnected', () => {
		const view = mount();
		view.state.projection.approvals = [{ id: '22222222-2222-2222-2222-222222222222', action: 'write patch', risk: 'High' }];
		view.update(false);
		expect(view.dom.window.document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
		expect([...view.dom.window.document.querySelectorAll<HTMLButtonElement>('#approvals button')].every(button => button.disabled)).toBe(true);
		view.state.status = 'reconnecting'; view.update(true);
		expect(view.dom.window.document.querySelector<HTMLButtonElement>('#send')!.disabled).toBe(true);
	});
});
