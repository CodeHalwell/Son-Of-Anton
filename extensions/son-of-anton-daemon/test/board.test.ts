/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { renderBoardHtml } from '../src/html.js';

describe('shared board boundary', () => {
	it('renders untrusted cards as text and keeps mutations disabled until trusted', () => {
		const dom = new JSDOM(renderBoardHtml({ nonce: 'fixture', cspSource: 'https://fixture', style: 'https://fixture/board.css', localize: text => text }), { runScripts: 'outside-only' });
		try {
			const sent: object[] = [];
			Object.assign(dom.window, { acquireVsCodeApi: () => ({ postMessage: (message: object) => sent.push(message) }) });
			dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
			const publish = (trusted: boolean) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'board', repository: '/repo', trusted,
				items: [{ id: 'server-card', status: 'doing', revision: 3, payload: { title: '<img src=x onerror=alert(1)>' } }] } }));
			publish(false);
			expect(dom.window.document.querySelector('img')).toBeNull();
			expect(dom.window.document.querySelector('article h4')?.textContent).toContain('<img');
			const button = dom.window.document.querySelector('article button') as HTMLButtonElement;
			expect(button.disabled).toBe(true);
			publish(true);
			(dom.window.document.querySelector('article button') as HTMLButtonElement).click();
			expect(sent.at(-1)).toEqual({ type: 'move', id: 'server-card' });
		} finally { dom.window.close(); }
	});
});
