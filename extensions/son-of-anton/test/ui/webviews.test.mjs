/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Exercises the shipped webview HTML, CSS and bundle with an offline host fixture.
// Build core + extension first. Run: node --test test/ui/webviews.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const extension = fileURLToPath(new URL('../..', import.meta.url));
const root = path.resolve(extension, '../..');
const { PERSONAS, getRoster } = require(path.join(root, 'son-of-anton-core/dist/chat/personas.js'));
const { SPECIALIST_ROLES } = require(path.join(root, 'son-of-anton-core/dist/chat/specialistRegistry.js'));
const { MODEL_METADATA } = require(path.join(root, 'son-of-anton-core/dist/llm/modelMetadata.js'));
const theme = {
	'font-family': 'system-ui, sans-serif', 'font-size': '13px', 'foreground': '#dce2ec',
	'editor-background': '#171a20', 'sideBar-background': '#1c2027', 'editorWidget-background': '#242a33',
	'descriptionForeground': '#a4afbf', 'panel-border': '#373f4b', 'input-background': '#242a33', 'input-foreground': '#e4e9f2',
	'input-placeholderForeground': '#a4afbf', 'button-background': '#2868ba', 'button-foreground': '#ffffff',
	'button-hoverBackground': '#357ac9', 'focusBorder': '#78afff', 'textLink-foreground': '#78afff',
	'badge-background': '#333e50', 'badge-foreground': '#e4e9f2', 'dropdown-background': '#242a33',
	'charts-green': '#80cda8', 'charts-yellow': '#e5bf70', 'charts-blue': '#78afff', 'charts-purple': '#bda0ed', 'errorForeground': '#ff9c8c',
};
const fixture = {
	type: 'snapshot', conversationId: 'ui-fixture', conversationTitle: 'Build a better developer experience',
	personas: getRoster(), snapshot: { conversationId: 'ui-fixture', createdAt: 1, tasks: [
		['backlog', 'Document the new workspace setup', 'anton-docs', 'docs/getting-started.md'],
		['ready', 'Add keyboard navigation to the task board', 'anton-code', 'src/board/navigation.ts'],
		['in-progress', 'Keep long conversations responsive while tokens stream', 'anton-code', 'src/chat/streaming.ts'],
		['review', 'Review checkpoint recovery and workspace isolation', 'anton-security', 'src/checkpoint/store.ts'],
		['done', 'Index source changes without stale symbols', 'anton-code', 'src/graph/index.ts'],
		['failed', 'Validate the installed application on a clean machine', 'anton-test', 'test/installation.test.ts'],
	].map(([state, instruction, assignee, file], index) => ({ id: `task-${index}`, state, instruction, assignee, scopeFiles: [file], dependencies: index === 3 ? ['task-1'] : [], summary: state === 'failed' ? 'The native module is missing from the packaged application.' : undefined })) },
};
let browser;
before(async () => { browser = await chromium.launch({ ...(process.env.SOTA_UI_BROWSER ? { executablePath: process.env.SOTA_UI_BROWSER } : {}), headless: true }); });
after(async () => { await browser?.close(); });

async function openSurface(t, surface, width = 1440, initialState, suppliedHtml, specialists = SPECIALIST_ROLES) {
	const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
	t.after(() => context.close());
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	t.after(() => assert.deepEqual(errors, [], 'The webview must not throw during interaction'));
	await page.addInitScript(({ values, initialState }) => {
		window.sentMessages = [];
		let state = initialState;
		window.acquireVsCodeApi = () => ({ postMessage: message => window.sentMessages.push(message), getState: () => state, setState: next => { state = next; window.savedWebviewState = next; } });
		document.addEventListener('DOMContentLoaded', () => {
			for (const [name, value] of Object.entries(values)) document.documentElement.style.setProperty('--vscode-' + name, value);
			document.body.classList.add('vscode-dark');
		});
	}, { values: theme, initialState });
	let html;
	if (suppliedHtml) {
		html = suppliedHtml;
	} else if (surface === 'chat') {
		const source = await readFile(path.join(extension, 'src/chat/ChatPanel.ts'), 'utf8');
		html = source.slice(source.indexOf('return /* html */`<!DOCTYPE html>')).split('`')[1];
		const labelsSource = await readFile(path.join(extension, 'src/chat/chatUiStrings.ts'), 'utf8');
		const labels = Object.fromEntries([...labelsSource.matchAll(/(\w+): vscode\.l10n\.t\('([^']*)'\)/g)].map(match => [match[1], match[2]]));
		const values = { conversationId: 'initial-conversation', uiStringsJson: JSON.stringify(labels), 'this.webview.cspSource': 'https://sota.test', nonce: 'ui-fixture', cssUri: 'https://sota.test/chat.css', workflowsJsUri: 'https://sota.test/chat-workflows.js', webviewJsUri: 'https://sota.test/chat-webview.js', defaultModel: 'sonnet', initialTab: 'chat', specialistRolesJson: JSON.stringify(specialists), personasJson: JSON.stringify(PERSONAS), rosterJson: JSON.stringify(getRoster()), slashCommandsJson: '[]', modelMetadataJson: JSON.stringify(MODEL_METADATA) };
		html = html.replace(/\$\{([^}]+)\}/g, (_, name) => { assert.ok(name in values, name); return values[name]; });
	} else { html = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script src="https://sota.test/board.js"></script></body></html>'; }
	await context.route('**/*', async route => {
		const url = new URL(route.request().url());
		if (url.origin !== 'https://sota.test') { await route.abort(); return; }
		const asset = { '/chat.css': 'media/chat.css', '/chat-webview.js': 'media/chat-webview.js', '/chat-workflows.js': 'dist/chat-workflows.js', '/board.js': 'dist/board.js', '/council.js': 'media/council.js', '/council.css': 'media/council.css' }[url.pathname];
		await route.fulfill({ status: 200, contentType: asset ? (asset.endsWith('.css') ? 'text/css' : 'text/javascript') : 'text/html', body: asset ? await readFile(path.join(extension, asset)) : html });
	});
	await page.goto('https://sota.test/');
	await page.locator(surface === 'chat' ? '#messageInput' : suppliedHtml ? 'body' : '.shell').waitFor();
	return page;
}

/** Exercise the panel's actual HTML generator without starting native services. */
async function panelHtml(relativeFile, exportName, method, args = []) {
	const filename = path.join(extension, 'src', relativeFile + '.ts');
	const typescript = require('typescript');
	const source = await readFile(filename, 'utf8');
	const compiled = typescript.transpileModule(source, { compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 } }).outputText;
	const exports = {};
	const sourceRequire = createRequire(filename);
	const localRequire = name => name === 'vscode' ? { l10n: { t: (value, ...args) => value.replace(/\{(\d+)\}/g, (match, index) => args[Number(index)] === undefined ? match : String(args[Number(index)])) } } : name.startsWith('son-of-anton-core/') ? require(path.join(root, 'son-of-anton-core/dist', name.slice('son-of-anton-core/'.length))) : sourceRequire(name);
	new Function('require', 'exports', compiled)(localRequire, exports);
	if (!method) { return exports[exportName](...args); }
	const panel = Object.assign(Object.create(exports[exportName].prototype), { panel: { webview: { cspSource: 'https://sota.test' } } });
	return panel[method](...args);
}
async function post(page, message) { await page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data, origin: window.origin, source: window.parent })), message); }

test('proposal review supports safe file selection, diffs, validation logs and restore at sidebar widths', async t => {
	const maliciousName = '<img src=x onerror=alert(1)>.ts';
	const proposal = { id: 'proposal', files: ['src/validator.ts', 'src/api.ts', maliciousName], appliedFiles: ['src/api.ts'], applications: [{ files: ['src/api.ts'], recovery: { ref: 'checkpoint' } }], validation: { status: 'failed', commands: [{ script: 'test', exitCode: 7, durationMs: 1200, log: '/fixture.log' }], error: 'Test failed <script>alert(1)</script>' } };
	const html = await panelHtml('council/ProposalReviewPanel', 'proposalReviewHtml', undefined, [proposal, ['src/validator.ts'], false]);
	const page = await openSurface(t, 'proposal', 420, undefined, html);
	assert.equal(await page.locator('img').count(), 0);
	assert.equal(await page.locator('[data-select="1"]').isDisabled(), true);
	await page.locator('[data-diff="0"]').click(); await page.locator('[data-select="2"]').check();
	await page.locator('[data-action="validate"]').click(); await page.locator('[data-log="0"]').click(); await page.locator('[data-action="restore"]').click();
	assert.deepEqual(await page.evaluate(() => sentMessages), [{ type: 'diff', file: 'src/validator.ts' }, { type: 'select', files: ['src/validator.ts', maliciousName] }, { type: 'validate' }, { type: 'log', index: 0 }, { type: 'restore' }]);
	await assertNoPageOverflow(page); await screenshot(page, 'proposal-review-adversarial');
	const busyHtml = await panelHtml('council/ProposalReviewPanel', 'proposalReviewHtml', undefined, [proposal, ['src/validator.ts'], true]);
	const busyPage = await openSurface(t, 'proposal', 420, undefined, busyHtml);
	assert.equal(await busyPage.locator('[data-action="apply"]').isDisabled(), true);
	await busyPage.locator('[data-action="cancel"]').click(); assert.deepEqual(await busyPage.evaluate(() => sentMessages), [{ type: 'cancel' }]);
	const passed = { ...proposal, files: ['src/validation/clamp.ts', 'test/clamp.test.ts', 'docs/api.md'], appliedFiles: [], validation: { status: 'passed', commands: [{ script: 'build', exitCode: 0, durationMs: 1240 }, { script: 'test', exitCode: 0, durationMs: 930 }] } };
	const reviewPage = await openSurface(t, 'proposal', 560, undefined, await panelHtml('council/ProposalReviewPanel', 'proposalReviewHtml', undefined, [passed, passed.files.slice(0, 2), false]));
	assert.match(await reviewPage.locator('[role="status"]').innerText(), /passed · 2 Commands/);
	await screenshot(reviewPage, 'proposal-review');
});
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function screenshot(page, name) {
	if (!process.env.SOTA_UI_SCREENSHOTS) return;
	await mkdir(process.env.SOTA_UI_SCREENSHOTS, { recursive: true });
	await page.screenshot({ path: path.join(process.env.SOTA_UI_SCREENSHOTS, name + '.png') });
}
async function assertNoPageOverflow(page) {
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Only the board, not the whole page, may scroll horizontally');
}

test('chat: responsive welcome, provider search, keyboard tabs and composer', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.locator('#emptyStateReady').waitFor({ state: 'visible' });
	await screenshot(page, 'chat-welcome');
	await page.getByRole('button', { name: /Understand the Code/ }).click();
	assert.match(await page.locator('#messageInput').inputValue(), /Explain what/);
	await page.getByRole('tab', { name: 'Chat tab', exact: true }).focus();
	await page.keyboard.press('ArrowRight');
	assert.equal(await page.getByRole('tab', { name: 'Tasks tab', exact: true }).getAttribute('aria-selected'), 'true');
	await page.getByRole('tab', { name: 'Chat tab', exact: true }).click();
	await post(page, { type: 'connectionState', status: { providers: [], apiKeys: {} } });
	await page.getByRole('searchbox', { name: 'Find a provider' }).fill('ollama');
	assert.equal(await page.locator('#emptyStateProviders .provider-card:visible').count(), 1);
	await page.getByRole('searchbox', { name: 'Find a provider' }).fill('does-not-exist');
	await page.locator('#providerSearchEmpty').waitFor({ state: 'visible' });
	for (const width of [280, 400, 800]) { await page.setViewportSize({ width, height: 900 }); await assertNoPageOverflow(page); }
});

test('reuse prompt restores persisted attachments and preferences, with Undo for the existing draft', async t => {
	const page = await openSurface(t, 'chat', 400);
	const image = { type: 'image', mimeType: 'image/png', base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', name: 'example.png' };
	await post(page, { type: 'loadConversation', conversationId: 'reusable', messages: [
		{ role: 'user', content: [image, { type: 'text', text: 'Explain the attached example' }], model: 'haiku', specialistId: 'anton-code', request: { text: 'Explain the attached example', attachments: ['terminal-output'], mentionsKinded: [{ kind: 'file', path: 'src/example.ts' }, { kind: 'problems' }], chatMode: 'plan', includeWorkspaceContext: false } },
		{ role: 'assistant', content: 'Here is the explanation.' },
	] });
	await page.locator('#messageInput').fill('Do not lose this draft');
	await page.locator('#attachBtn').click(); await page.locator('[data-attach="current-file"]').click();
	await page.getByRole('button', { name: 'Reuse Prompt', exact: true }).click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'Explain the attached example');
	assert.match(await page.locator('#contextChips').innerText(), /Terminal output[\s\S]*example.png[\s\S]*src\/example.ts[\s\S]*@problems/);
	assert.equal(await page.locator('#includeWorkspaceContext').isChecked(), false);
	assert.equal(await page.locator('#planActBtnPlan').getAttribute('aria-checked'), 'true');
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length), 0);
	assert.equal(await page.locator('.msg-user').count(), 1);
	await screenshot(page, 'prompt-reuse'); await assertNoPageOverflow(page);
	await page.locator('#undoPromptRestore').click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'Do not lose this draft');
	assert.match(await page.locator('#contextChips').innerText(), /Current file/);
	assert.equal(await page.locator('#contextChips .attachment-thumb').count(), 0);
	await page.getByRole('button', { name: 'Reuse Prompt', exact: true }).click();
	await page.locator('#sendBtn').click();
	const sent = await page.evaluate(() => sentMessages.find(message => message.type === 'sendMessage'));
	assert.deepEqual({ text: sent.text, model: sent.model, agent: sent.specialistId, mode: sent.chatMode, context: sent.includeWorkspaceContext, attachments: sent.attachments, mentions: sent.mentionsKinded, images: sent.images }, { text: 'Explain the attached example', model: 'haiku', agent: 'anton-code', mode: 'plan', context: false, attachments: ['terminal-output'], mentions: [{ kind: 'file', path: 'src/example.ts' }, { kind: 'problems' }], images: [{ mime: image.mimeType, base64: image.base64Data, name: image.name }] });
	assert.equal(await page.locator('#promptRestoreNotice').isVisible(), false);
});

test('failed attachment-only requests can be restored without sending a duplicate', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.locator('#attachBtn').click(); await page.locator('[data-attach="terminal-output"]').click();
	await page.locator('#sendBtn').click();
	assert.match(await page.locator('.msg-user').innerText(), /Terminal output/);
	await post(page, { type: 'streamError', error: 'Provider unavailable' });
	await page.getByRole('button', { name: 'Reuse Prompt', exact: true }).click();
	assert.equal(await page.locator('#messageInput').inputValue(), '');
	assert.match(await page.locator('#contextChips').innerText(), /Terminal output/);
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length), 1);
});

test('older responses reuse their own prompt and stale controls cannot replace another conversation draft', async t => {
	const page = await openSurface(t, 'chat', 420);
	const messages = Array.from({ length: 220 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'Message ' + index }));
	await post(page, { type: 'loadConversation', conversationId: 'history-a', messages });
	await page.getByRole('button', { name: /Show Earlier Messages/ }).click();
	await page.getByRole('button', { name: 'Reuse Prompt', exact: true }).first().click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'Message 0');
	await page.evaluate(() => { window.staleReuse = document.querySelector('.msg-action-reuse'); });
	await post(page, { type: 'loadConversation', conversationId: 'history-b', messages: [] });
	await page.locator('#messageInput').fill('Current conversation draft');
	await page.evaluate(() => window.staleReuse.click());
	assert.equal(await page.locator('#messageInput').inputValue(), 'Current conversation draft');
	assert.equal(await page.locator('#promptRestoreNotice').isVisible(), false);
});

test('suggested follow-ups stage the correct text and preserve the previous draft with Undo', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.locator('#messageInput').fill('Explain'); await page.locator('#sendBtn').click();
	await post(page, { type: 'streamToken', token: 'Explanation.\n<<sota:suggestions>>["Add meaningful tests"]<<sota:end>>' });
	await post(page, { type: 'messageComplete' });
	await page.locator('#messageInput').fill('Existing draft');
	await page.getByRole('button', { name: 'Add meaningful tests', exact: true }).click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'Add meaningful tests');
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length), 1);
	await page.locator('#undoPromptRestore').click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'Existing draft');
});

test('terminal attachments explain capture and terminal settings save real preferences', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.locator('#attachBtn').click();
	await page.locator('[data-attach="terminal-output"]').click();
	assert.match(await page.locator('#contextChips .context-chip').getAttribute('title'), /latest command and output/);
	await page.locator('#sendBtn').click();
	const sent = await page.evaluate(() => sentMessages.find(message => message.type === 'sendMessage'));
	assert.deepEqual(sent.attachments, ['terminal-output']);
	await post(page, { type: 'requestSettled', cancelled: false });
	await page.getByRole('tab', { name: 'Settings tab', exact: true }).click();
	await page.locator('#settingsTab-terminal').click();
	await post(page, { type: 'settingsState', settings: { 'sota.terminal.shellIntegration': true, 'sota.terminal.outputLineCap': 100 } });
	assert.match(await page.locator('#settingsSubtab-terminal').innerText(), /running commands[\s\S]*16 KiB/);
	await page.getByRole('checkbox', { name: 'Capture Terminal Output', exact: true }).uncheck();
	await page.locator('#settingsTerminalLineCap').focus();
	await page.locator('#settingsTerminalLineCap').press('ArrowRight');
	const changes = await page.evaluate(() => sentMessages.filter(message => message.type === 'settingChange'));
	assert.ok(changes.some(message => message.settingId === 'sota.terminal.shellIntegration' && message.value === false));
	assert.ok(changes.some(message => message.settingId === 'sota.terminal.outputLineCap' && message.value === 110));
	for (const width of [280, 400, 800]) {
		await page.setViewportSize({ width, height: 900 });
		const tabHeights = await page.locator('.settings-subtab').evaluateAll(tabs => tabs.map(tab => tab.getBoundingClientRect().height));
		assert.ok(tabHeights.every(height => height <= 44), 'Settings tabs should remain compact at every width');
		await assertNoPageOverflow(page);
	}
	await page.setViewportSize({ width: 400, height: 900 });
	await screenshot(page, 'terminal-capture-settings');
});

test('chat: batched streaming preserves reading position, text, and composer focus', async t => {
	const page = await openSurface(t, 'chat', 420);
	await page.locator('#messageInput').fill('Review this implementation');
	await page.locator('#messageInput').press('Enter');
	await post(page, { type: 'streamToken', token: 'A long response.\n'.repeat(150) });
	await frames(page);
	await page.locator('#messageList').evaluate(list => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); });
	await page.locator('#messageInput').focus();
	await page.evaluate(() => { for (let i = 0; i < 1000; i++) window.dispatchEvent(new MessageEvent('message', { data: { type: 'streamToken', token: 'x' } })); });
	await frames(page);
	assert.equal(await page.locator('#messageList').evaluate(list => list.scrollTop), 0);
	assert.equal(await page.locator('#messageInput').evaluate(input => input === document.activeElement), true);
	await page.locator('#jumpToLatest').waitFor({ state: 'visible' });
	await post(page, { type: 'messageComplete', totalTokens: 1200, estimatedCost: '0.01' });
	assert.match(await page.locator('.msg-text-rendered').textContent(), /x{1000}/);
	await page.locator('#jumpToLatest').click();
	await frames(page);
	assert.equal(await page.locator('#messageList').evaluate(list => list.scrollHeight - list.clientHeight - list.scrollTop < 2), true);
	await screenshot(page, 'chat-streaming');
	await page.locator('#messageInput').fill('Start another task');
	await page.locator('#messageInput').press('Enter');
	await page.locator('#sendBtn.is-streaming').waitFor();
	await post(page, { type: 'loadConversation', messages: [] });
	assert.equal(await page.getByRole('button', { name: 'Stop generating', exact: true }).count(), 0);
});

test('chat: live Markdown hides protocol fragments and preserves tool controls and source code', async t => {
	const page = await openSurface(t, 'chat', 420);
	await page.locator('#messageInput').fill('Explain this example');
	await page.locator('#messageInput').press('Enter');
	await post(page, { type: 'streamToken', token: '## Result\n\n```ts\nconst example = "<tag>";' });
	await frames(page);
	assert.equal(await page.locator('.thinking-indicator').count(), 0);
	assert.equal(await page.locator('.msg-text-stream h2').textContent(), 'Result');
	assert.equal(await page.locator('.msg-text-stream pre code').textContent(), 'const example = "<tag>";');
	await post(page, { type: 'streamToken', token: '\n```' });
	await post(page, { type: 'toolCall', id: 'read', name: 'read_file', input: { path: 'clamp.ts' }, status: 'done', output: 'Read complete' });
	await post(page, { type: 'streamToken', token: '\n\nFinished.\n<<sota:sug' });
	await frames(page);
	assert.doesNotMatch(await page.locator('.msg-body').last().textContent(), /<<sota/);
	await post(page, { type: 'streamToken', token: 'gestions>>["Explain the guard"]<<sota:end>>' });
	await frames(page);
	assert.doesNotMatch(await page.locator('.msg-body').last().textContent(), /Explain the guard|sota:end/);
	await post(page, { type: 'messageComplete', inputTokens: 12, outputTokens: 34, totalTokens: 46, estimatedCost: '0.00' });
	assert.equal(await page.locator('.tool-card').count(), 1);
	assert.deepEqual(await page.locator('.tool-card').evaluate(card => ({ status: card.dataset.toolStatus, label: card.querySelector('.tool-card-status').textContent, icon: card.querySelector('.tool-card-icon').textContent })), { status: 'ok', label: 'Ok', icon: '✓' });
	assert.equal(await page.locator('.msg-text-rendered pre code').textContent(), 'const example = "<tag>";');
	await page.getByRole('button', { name: 'Explain the guard', exact: true }).waitFor();
	assert.match(await page.locator('#transcriptTaskMeter').textContent(), /12.*34/);
	await post(page, { type: 'messageComplete', usageUnavailable: true });
	await post(page, { type: 'sessionUsage', totalTokens: 46, totalCost: 0, turnCount: 2, unmeteredTurns: 1 });
	assert.equal(await page.locator('#tokenCount').textContent(), 'Usage Unavailable');
	assert.equal(await page.locator('#sessionUsageCost').textContent(), '—');
});

test('chat: Markdown tables render accessible cells without overflowing narrow conversations', async t => {
	const page = await openSurface(t, 'chat', 420);
	const content = '## Edge cases\n\n| Input | Result | Notes |\n|:---|---:|:---:|\n| `min > max` | `max` | **Validate bounds** |\n| `a | b` | 3 | escaped \\| pipe |\n| <script>alert(1)</script> | 0 | [Docs](https://example.com) |\n\nDone.';
	await post(page, { type: 'loadConversation', messages: [{ role: 'assistant', content }] });
	assert.equal(await page.locator('.markdown-table tbody tr').count(), 3);
	assert.deepEqual(await page.locator('.markdown-table tbody tr').nth(1).locator('td').allTextContents(), ['a | b', '3', 'escaped | pipe']);
	assert.equal(await page.locator('.markdown-table script').count(), 0);
	assert.equal(await page.locator('.markdown-table th[scope="col"]').count(), 3);
	await page.getByRole('region', { name: 'Response Table' }).focus();
	assert.equal(await page.locator('body').evaluate(body => body.scrollWidth <= window.innerWidth), true);
	await screenshot(page, 'markdown-table');
});

test('sidebar chat: compact conversations keep menus, streaming and composer controls reachable', async t => {
	const page = await openSurface(t, 'chat', 360);
	const content = '## Bounds check\n\n| Input | Result | Explanation |\n|---|---|---|\n| `clamp(5, 0, 10)` | `5` | Within the bounds |\n| `clamp(-2, 0, 10)` | `0` | Below the minimum |\n| `clamp(8, 10, 5)` | `5` | Reversed bounds need validation |\n\n```typescript\nif (min > max) {\n\tthrow new RangeError("Minimum must not exceed maximum");\n}\n```\n\n[Documentation](https://example.com/docs)';
	await post(page, { type: 'loadConversation', messages: [{ role: 'user', content: 'Explain bounds validation in this example' }, { role: 'assistant', content, specialistId: 'anton-docs' }] });
	await post(page, { type: 'costUpdate', tokens: 12000, inputTokens: 10000, outputTokens: 2000, dollars: 0.24 });
	await post(page, { type: 'messageComplete', usageUnavailable: true });
	await post(page, { type: 'sessionUsage', totalTokens: 12000, totalCost: 0.24, turnCount: 3, unmeteredTurns: 1 });
	const visibleBounds = async selector => {
		const box = await page.locator(selector).boundingBox();
		const viewport = page.viewportSize();
		assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${selector} must fit inside the sidebar: ${JSON.stringify(box)}`);
	};
	for (const viewport of [{ width: 360, height: 620 }, { width: 280, height: 480 }, { width: 420, height: 540 }]) {
		await page.setViewportSize(viewport);
		await frames(page);
		await assertNoPageOverflow(page);
		await page.locator('#messageList').evaluate(list => { list.scrollTop = list.scrollHeight; });
		const listBounds = await page.locator('#messageList').boundingBox();
		const headerBounds = await page.locator('#transcriptTaskHeader').boundingBox();
		assert.ok(Math.abs(headerBounds.y - listBounds.y) <= 1, 'The pinned task header must cover the top of the transcript');
		const linkBounds = await page.getByRole('link', { name: 'Documentation', exact: true }).boundingBox();
		const codeBounds = await page.locator('.code-block').boundingBox();
		assert.ok(linkBounds.y - (codeBounds.y + codeBounds.height) <= 32, 'Code fences must not create empty text rows before the next paragraph');
		const actionBounds = await page.locator('.msg-assistant .msg-actions').boundingBox();
		assert.ok(actionBounds.y >= linkBounds.y + linkBounds.height, 'Message actions must occupy their own row below the response');
		for (const selector of ['#messageInput', '#sendBtn', '#newChatBtn', '#sessionUsage']) { await visibleBounds(selector); }
		assert.ok((await page.locator('#messageList').boundingBox()).height >= 100, 'The transcript needs reading space above the composer');
		for (const [anchor, menu] of [['#modelChip', '#modelMenu'], ['#agentChip', '#agentMenu'], ['#hdrCost', '#hdrCostPopover']]) {
			await page.locator(anchor).click();
			await visibleBounds(menu);
			await page.locator(anchor).click();
		}
		await screenshot(page, `sidebar-chat-${viewport.width}`);
	}
	await page.locator('#messageInput').fill('Explain the guard');
	await page.locator('#messageInput').press('Enter');
	await post(page, { type: 'streamToken', token: '## Validate first\n\nReject reversed bounds before clamping.' });
	await frames(page);
	await visibleBounds('#sendBtn');
	await page.locator('#sendBtn').click();
	assert.equal(await page.evaluate(() => sentMessages.some(message => message.type === 'cancelRequest')), true);
});

test('board: complete lifecycle, filters, keyboard card actions and responsive layout', async t => {
	const page = await openSurface(t, 'board');
	await post(page, fixture);
	await page.locator('.tile').first().waitFor();
	assert.equal(await page.locator('.column').count(), 6);
	assert.equal(await page.locator('.column[data-state="review"] .tile').count(), 1);
	await screenshot(page, 'task-board');
	await page.getByRole('searchbox', { name: 'Search tasks' }).fill('navigation.ts');
	assert.equal(await page.locator('.tile').count(), 1);
	await page.getByRole('button', { name: 'Run Task', exact: true }).focus();
	await page.keyboard.press('Enter');
	assert.equal(await page.evaluate(() => sentMessages.some(message => message.type === 'dispatch' && message.taskId === 'task-1')), true);
	await page.getByRole('button', { name: 'Clear Filters' }).click();
	await page.getByRole('button', { name: /Needs Attention/ }).click();
	assert.equal(await page.locator('.tile').count(), 1);
	await page.locator('.task-details summary').focus();
	await page.keyboard.press('Enter');
	assert.equal(await page.locator('.task-details').getAttribute('open'), '');
	await page.getByRole('button', { name: 'Clear Filters' }).click();
	for (const width of [1440, 900, 400, 280]) { await page.setViewportSize({ width, height: 900 }); await assertNoPageOverflow(page); }
	await screenshot(page, 'task-board-narrow');
});

test('chat controls: code actions execute under the shipped content security policy', async t => {
	const page = await openSurface(t, 'chat', 420);
	const code = '// path: src/example.ts\nexport const answer = 42;';
	const diff = '--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;';
	await post(page, { type: 'loadConversation', messages: [{ role: 'assistant', content: '```ts\n' + code + '\n```\n\n```diff\n' + diff + '\n```' }] });
	await page.locator('.code-copy').first().click();
	await page.locator('.code-open').first().click();
	await page.locator('.code-save').first().click();
	await page.locator('.code-diff').click();
	const messages = await page.evaluate(() => sentMessages);
	assert.deepEqual(messages.filter(message => ['copyCode', 'openCodeInEditor', 'saveCodeToFile', 'previewDiff'].includes(message.type)), [
		{ type: 'copyCode', text: code }, { type: 'openCodeInEditor', code, language: 'ts' },
		{ type: 'saveCodeToFile', code, relPath: 'src/example.ts' }, { type: 'previewDiff', diff: diff + '\n' },
	]);
});

test('trace viewer: live data, every filter, keyboard details, refresh and export', async t => {
	const html = await panelHtml('trace/TraceViewerPanel', 'TraceViewerPanel', 'getHtmlContent', [{}]);
	const page = await openSurface(t, 'panel', 800, undefined, html);
	const types = ['llm_call', 'mcp_tool', 'file_change', 'hook', 'lifecycle'];
	const spans = types.map((type, index) => ({ id: 'span-' + index, name: 'Review ' + type, type, startTime: 1000 + index * 100, endTime: 2000 + index * 100, taskId: 'task-1', attributes: { detail: '<script>escaped content</script>' } }));
	await post(page, { type: 'traceData', spans, tokenUsage: { input: 10, output: 20 }, estimatedCost: '0.04', focusTaskId: 'task-1', focusTaskLabel: 'Review UI', totalSpans: 5 });
	assert.equal(await page.locator('.span-row').count(), 5);
	for (const type of types) {
		await page.locator('#filterType').selectOption(type);
		assert.equal(await page.locator('.span-row').count(), 1);
		await page.locator('.span-row').focus();
		await page.keyboard.press('Enter');
		assert.equal(await page.locator('#detailTitle').textContent(), 'Review ' + type);
	}
	await page.locator('#filterType').selectOption('all');
	for (const selector of ['#refreshBtn', '#exportBtn', '#clearTaskFilterBtn']) { await page.locator(selector).click(); }
	assert.deepEqual(await page.evaluate(() => sentMessages.map(message => message.type)), ['refresh', 'exportTraces', 'clearTaskFilter']);
	await page.setViewportSize({ width: 360, height: 620 });
	await assertNoPageOverflow(page);
	await screenshot(page, 'trace-viewer');
});

test('setup wizard: every provider form, help, save feedback, back, cancel and skip', async t => {
	const html = await panelHtml('onboarding/SetupWizardPanel', 'SetupWizardPanel', 'renderHtml');
	const page = await openSurface(t, 'panel', 760, undefined, html);
	for (const provider of ['anthropic', 'openai', 'foundry', 'bedrock', 'google']) {
		await page.locator(`.card[data-provider="${provider}"]`).click();
		assert.equal(await page.locator(`#form-${provider}`).getAttribute('class'), 'section active', JSON.stringify(await page.evaluate(() => ({ messages: sentMessages, sections: [...document.querySelectorAll('.section')].map(section => [section.id, section.className]) }))));
		const form = page.locator(`form[data-provider="${provider}"]`);
		for (const input of await form.locator('input').all()) { await input.fill('ui-fixture'); }
		await page.locator(`#form-${provider} .link`).click();
		await form.getByRole('button', { name: 'Save and validate', exact: true }).click();
		assert.equal(await page.evaluate(provider => sentMessages.some(message => message.type === 'save-credentials' && message.provider === provider), provider), true);
		await post(page, { type: 'save-result', provider, ok: false, message: 'Fixture: check these credentials' });
		assert.match(await form.locator('.status').textContent(), /check these credentials/);
		await post(page, { type: 'save-result', provider, ok: true, message: 'Fixture: configured' });
		await form.getByRole('button', { name: 'Cancel', exact: true }).click();
		await page.locator(`.card[data-provider="${provider}"]`).click();
		await page.locator(`#form-${provider} button[data-target="picker"]`).click();
	}
	await page.locator('#skip-button').click();
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'open-link').length), 5);
	assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'skip');
	await page.setViewportSize({ width: 280, height: 620 });
	await assertNoPageOverflow(page);
	await screenshot(page, 'setup-wizard');
});

test('impact analysis: every filter and keyboard file navigation handle long content', async t => {
	const nodes = ['direct', 'transitive', 'test', 'documentation'].map((type, index) => ({ id: String(index), label: 'Review ' + type, filePath: '/workspace/' + 'long-folder/'.repeat(12) + type + '.ts', type, depth: index }));
	const html = await panelHtml('impact/ImpactAnalysisPanel', 'ImpactAnalysisPanel', 'getHtml', [{ target: { name: 'clamp', filePath: '/workspace/example.ts' }, nodes, edges: [], summary: { directCount: 1, transitiveCount: 1, testCount: 1, documentationCount: 1 } }]);
	const page = await openSurface(t, 'panel', 800, undefined, html);
	for (const node of nodes) {
		await page.locator(`[data-filter="${node.type}"]`).click();
		assert.equal(await page.locator('.node-item').count(), 1);
		await page.locator('.node-item').focus();
		await page.keyboard.press('Enter');
		assert.equal(await page.evaluate(() => sentMessages.at(-1)?.filePath), node.filePath);
	}
	await page.locator('[data-filter="all"]').click();
	assert.equal(await page.locator('.node-item').count(), 4);
	await page.setViewportSize({ width: 360, height: 620 });
	await assertNoPageOverflow(page);
	await screenshot(page, 'impact-analysis');
});

test('fleet dashboard: active, failed and completed tasks expose refresh, cancellation and results', async t => {
	const task = { id: 'active', name: 'Review a long-running UI task', status: 'running', startedAt: Date.now() - 5000, completedAt: Date.now(), progress: { percentage: 50, message: 'Checking controls' }, tokenUsage: { estimatedCostUsd: 0.1 } };
	const html = await panelHtml('dashboard/FleetDashboardPanel', 'FleetDashboardPanel', 'buildHtml', [[task], [{ ...task, id: 'done', status: 'completed' }], [], [{ type: 'error', message: 'A task needs attention' }]]);
	const page = await openSurface(t, 'panel', 800, undefined, html);
	for (const action of ['cancel', 'results', 'refresh']) { await page.locator(`[data-action="${action}"]`).click(); }
	assert.deepEqual(await page.evaluate(() => sentMessages), [{ command: 'cancelTask', taskId: 'active' }, { command: 'viewResults', taskId: 'done' }, { command: 'refresh' }]);
	await page.setViewportSize({ width: 360, height: 620 });
	await assertNoPageOverflow(page);
	await page.locator('[data-action="cancel"]').focus();
	await post(page, { type: 'dashboardUpdate', html });
	assert.equal(await page.locator('[data-action="cancel"]').evaluate(button => button === document.activeElement), true);
	await page.locator('[data-action="cancel"]').press('Enter');
	assert.equal(await page.evaluate(() => sentMessages.at(-1).command), 'cancelTask');
	await screenshot(page, 'fleet-dashboard');
});

test('board assistant: keep tool activity through tokens and cancel the host request', async t => {
	const page = await openSurface(t, 'board');
	await post(page, fixture);
	await page.getByRole('button', { name: 'Ask Anton', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message the board assistant' }).fill('Summarise progress');
	await page.getByRole('button', { name: 'Send ↑' }).click();
	const request = await page.evaluate(() => sentMessages.find(message => message.type === 'chat-runtime'));
	assert.ok(request);
	await post(page, { type: 'chat-runtime-chunk', requestId: request.requestId, event: { type: 'tool-call', id: 'call-1', name: 'setCardAssignee', input: { cardId: 'task-1', assignee: 'anton-code' } } });
	await post(page, { type: 'chat-runtime-chunk', requestId: request.requestId, event: { type: 'token', token: 'The plan is moving forward.' } });
	await frames(page);
	assert.equal(await page.locator('.chat-tool-call').count(), 1);
	await page.getByRole('textbox', { name: 'Message the board assistant' }).fill('A draft for later');
	await page.getByRole('button', { name: 'Stop', exact: true }).click();
	assert.equal(await page.evaluate(id => sentMessages.some(message => message.type === 'cancel-chat' && message.requestId === id), request.requestId), true);
	assert.equal(await page.getByRole('textbox', { name: 'Message the board assistant' }).inputValue(), 'A draft for later');
	await post(page, { type: 'chat-runtime-chunk', requestId: request.requestId, event: { type: 'token', token: 'LATE TOKEN' } });
	assert.doesNotMatch(await page.locator('.chat-log').textContent(), /LATE TOKEN/);
	await screenshot(page, 'board-assistant');
});

test('light and high contrast themes: empty board, provider picker, and conversation remain usable', async t => {
	const light = { ...theme, foreground: '#253143', 'editor-background': '#ffffff', 'sideBar-background': '#f6f7f9', 'editorWidget-background': '#f2f4f7', 'descriptionForeground': '#536175', 'panel-border': '#ced5df', 'input-background': '#f2f4f7', 'input-foreground': '#253143', 'input-placeholderForeground': '#536175', 'dropdown-background': '#f2f4f7', 'badge-background': '#e8ecf2', 'badge-foreground': '#253143', 'focusBorder': '#2868ba', 'charts-green': '#26734b', 'charts-yellow': '#88600b', 'charts-blue': '#2868ba', 'charts-purple': '#774ba8', 'errorForeground': '#b93828' };
	for (const surface of ['board', 'chat']) {
		const page = await openSurface(t, surface, surface === 'chat' ? 400 : 1440);
		await page.evaluate(values => { document.body.className = 'vscode-light'; for (const [name, value] of Object.entries(values)) document.documentElement.style.setProperty('--vscode-' + name, value); }, light);
		if (surface === 'board') {
			await screenshot(page, 'board-empty-light');
			await page.getByRole('button', { name: 'Open Chat', exact: false }).click();
			assert.equal(await page.evaluate(() => sentMessages.some(message => message.type === 'open-chat')), true);
			await post(page, fixture);
		} else {
			await screenshot(page, 'chat-welcome-light');
			await post(page, { type: 'connectionState', status: { providers: [], apiKeys: {} } });
			await page.getByRole('searchbox', { name: 'Find a provider' }).fill('OpenAI');
		}
		await screenshot(page, surface + '-light');
		await page.evaluate(() => { document.body.className = 'vscode-high-contrast'; document.documentElement.style.setProperty('--vscode-contrastBorder', '#000000'); });
		await assertNoPageOverflow(page);
		await screenshot(page, surface + '-contrast');
	}
});

test('history: search, date groups, active title, bounded rendering, and keyboard navigation', async t => {
	const page = await openSurface(t, 'chat', 400);
	const now = Date.now();
	const conversations = Array.from({ length: 80 }, (_, i) => ({ id: 'conversation-' + i, title: i === 2 ? 'Investigate authentication timeouts' : 'Implementation discussion ' + i, updatedAt: now - i * 24 * 60 * 60 * 1000, messageCount: i + 1, lastSpecialist: i === 2 ? 'anton-security' : 'anton-code' }));
	const snapshot = { type: 'historySnapshot', activeId: 'conversation-2', conversations };
	await post(page, snapshot);
	await page.getByRole('tab', { name: 'History tab', exact: true }).click();
	assert.equal(await page.locator('.history-pane-row').count(), 50);
	assert.equal(await page.locator('#conversationTitle').textContent(), 'Investigate authentication timeouts');
	await page.getByRole('button', { name: 'Show More', exact: true }).click();
	assert.equal(await page.locator('.history-pane-row').count(), 80);
	await page.getByRole('searchbox', { name: 'Search Conversations…' }).fill('anton-security');
	assert.equal(await page.locator('.history-pane-row').count(), 1);
	await page.locator('.history-pane-row-open').focus();
	await post(page, snapshot);
	assert.equal(await page.locator('.history-pane-row-open').evaluate(button => button === document.activeElement), true);
	await page.keyboard.press('Enter');
	assert.equal(await page.evaluate(() => sentMessages.some(message => message.command === 'sota.openConversation' && message.arg === 'conversation-2')), true);
	await page.getByRole('tab', { name: 'History tab', exact: true }).click();
	await screenshot(page, 'history-search');
	await page.getByRole('searchbox', { name: 'Search Conversations…' }).fill('no such conversation');
	await page.locator('#historyNoResults').waitFor({ state: 'visible' });
	for (const width of [280, 400, 800]) { await page.setViewportSize({ width, height: 900 }); await assertNoPageOverflow(page); }
});

test('history: debounce typing, flush explicit filters, reject stale results and cancel on close', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.clock.install(); await page.clock.pauseAt(Date.now());
	await page.evaluate(() => {
		sentMessages.length = 0;
		const input = document.getElementById('historySearch');
		for (const value of ['a', 'au', 'authentication']) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
	});
	await page.clock.runFor(249);
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'searchHistory').length), 0);
	await page.clock.runFor(1);
	const requests = () => page.evaluate(() => sentMessages.filter(message => message.type === 'searchHistory').map(({ query, historyScope, offset }) => ({ query, historyScope, offset })));
	assert.deepEqual(await requests(), [{ query: 'authentication', historyScope: 'active', offset: 0 }]);
	await page.evaluate(() => {
		const input = document.getElementById('historySearch'); input.value = 'latest'; input.dispatchEvent(new Event('input', { bubbles: true }));
		const view = document.getElementById('historyView'); view.value = 'archived'; view.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await page.clock.runFor(300);
	assert.deepEqual(await requests(), [{ query: 'authentication', historyScope: 'active', offset: 0 }, { query: 'latest', historyScope: 'archived', offset: 0 }]);
	const conversation = { id: 'matching', title: 'Latest result', updatedAt: Date.now(), messageCount: 1 };
	await post(page, { type: 'historySnapshot', query: 'latest', historyScope: 'archived', workspaceOnly: false, conversations: [conversation], nextOffset: 50 });
	await post(page, { type: 'historySnapshot', query: 'authentication', historyScope: 'active', workspaceOnly: false, conversations: [{ ...conversation, title: 'Obsolete result' }] });
	assert.equal(await page.locator('.history-pane-row-open').count(), 1);
	assert.match(await page.locator('.history-pane-row-open').textContent(), /Latest result/);
	await page.evaluate(() => {
		const input = document.getElementById('historySearch'); input.value = 'next'; input.dispatchEvent(new Event('input', { bubbles: true }));
		document.getElementById('historyShowMore').click();
	});
	assert.deepEqual((await requests()).at(-1), { query: 'next', historyScope: 'archived', offset: 0 });
	await page.evaluate(() => {
		const input = document.getElementById('historySearch'); input.value = 'submit'; input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	});
	await page.clock.runFor(300);
	assert.equal((await requests()).length, 4);
	assert.equal((await requests()).at(-1).query, 'submit');
	await page.evaluate(() => {
		const input = document.getElementById('historySearch'); input.value = 'closed'; input.dispatchEvent(new Event('input', { bubbles: true }));
		window.dispatchEvent(new Event('pagehide'));
	});
	await page.clock.runFor(300);
	assert.equal((await requests()).length, 4);
});

test('drafts: separate conversations, restore after reload, and clear only the sent draft', async t => {
	const page = await openSurface(t, 'chat', 420);
	await page.locator('#messageInput').fill('Please review my unfinished implementation');
	await page.getByRole('button', { name: 'Add context', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Current file', exact: true }).click();
	await post(page, { type: 'loadConversation', conversationId: 'second', messages: [] });
	assert.equal(await page.locator('#messageInput').inputValue(), '');
	assert.equal(await page.locator('#contextChips').textContent(), '');
	await page.locator('#messageInput').fill('A different draft');
	await post(page, { type: 'loadConversation', conversationId: 'initial-conversation', messages: [] });
	assert.equal(await page.locator('#messageInput').inputValue(), 'Please review my unfinished implementation');
	assert.match(await page.locator('#contextChips').textContent(), /Current file/i);
	const saved = await page.evaluate(() => savedWebviewState);
	const reloaded = await openSurface(t, 'chat', 420, saved);
	assert.equal(await reloaded.locator('#messageInput').inputValue(), 'Please review my unfinished implementation');
	await reloaded.locator('#messageInput').press('Enter');
	await post(reloaded, { type: 'messageComplete' });
	await post(reloaded, { type: 'loadConversation', conversationId: 'second', messages: [] });
	assert.equal(await reloaded.locator('#messageInput').inputValue(), 'A different draft');
	await post(reloaded, { type: 'conversationCleared', conversationId: 'fresh' });
	assert.equal(await reloaded.locator('#messageInput').inputValue(), '');
	await post(reloaded, { type: 'loadConversation', conversationId: 'initial-conversation', messages: [] });
	assert.equal(await reloaded.locator('#messageInput').inputValue(), '');
});

test('model picker: search by provider, choose with keyboard, escape restores focus, and narrow positioning', async t => {
	const page = await openSurface(t, 'chat', 280);
	await page.locator('#modelChip').click();
	await page.getByRole('searchbox', { name: 'Search Models…' }).fill('deepseek-v3');
	const visible = page.locator('#modelMenu [data-model]:visible');
	assert.ok(await visible.count() > 0);
	await page.keyboard.press('ArrowDown');
	assert.equal(await visible.first().evaluate(button => button === document.activeElement), true);
	const selected = await visible.first().getAttribute('data-model');
	await page.keyboard.press('Enter');
	await page.locator('#modelMenu').waitFor({ state: 'hidden' });
	assert.equal(await page.locator('#modelChip').evaluate(button => button === document.activeElement), true);
	assert.deepEqual(await page.evaluate(() => sentMessages.find(message => message.type === 'selectModel')), { type: 'selectModel', conversationId: 'initial-conversation', model: selected });
	await page.locator('#modelChip').click();
	await page.getByRole('searchbox', { name: 'Search Models…' }).fill('does-not-exist');
	await page.locator('#modelSearchEmpty').waitFor({ state: 'visible' });
	await page.keyboard.press('Escape');
	assert.equal(await page.locator('#modelChip').getAttribute('aria-expanded'), 'false');
	await page.locator('#messageInput').fill('Use the selected model');
	await page.locator('#messageInput').press('Enter');
	assert.equal(await page.evaluate(() => sentMessages.find(message => message.type === 'sendMessage').model), selected);
	await post(page, { type: 'messageComplete' });
	await page.locator('#modelChip').click();
	await page.getByRole('searchbox', { name: 'Search Models…' }).fill('claude');
	await assertNoPageOverflow(page);
	const bounds = await page.locator('#modelMenu').boundingBox();
	assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 280 && bounds.y >= 0);
	await screenshot(page, 'model-search');
});

test('models restore from the host across reload, chat switches, and New Chat without losing drafts', async t => {
	const staleDraft = { conversationDrafts: [['initial-conversation', { text: 'Unsent work', model: 'haiku', attachments: [], mentions: [] }]] };
	const page = await openSurface(t, 'chat', 420, staleDraft);
	await post(page, { type: 'loadConversation', conversationId: 'initial-conversation', lastModel: 'claude-code-opus', messages: [] });
	assert.match(await page.locator('#modelChip').textContent(), /Opus.*Claude Code/);
	assert.equal(await page.locator('#messageInput').inputValue(), 'Unsent work');
	await screenshot(page, 'restored-claude-model');
	await post(page, { type: 'loadConversation', conversationId: 'second', lastModel: 'haiku', messages: [] });
	assert.match(await page.locator('#modelChip').textContent(), /Haiku/);
	await post(page, { type: 'loadConversation', conversationId: 'initial-conversation', lastModel: 'claude-code-opus', messages: [] });
	assert.equal(await page.locator('#messageInput').inputValue(), 'Unsent work');
	await post(page, { type: 'conversationCleared', conversationId: 'fresh', lastModel: 'claude-code-opus' });
	assert.match(await page.locator('#modelChip').textContent(), /Opus.*Claude Code/);
	assert.equal(await page.locator('#messageInput').inputValue(), '');
	await page.locator('#messageInput').fill('Use the restored provider');
	await page.locator('#messageInput').press('Enter');
	assert.equal(await page.evaluate(() => sentMessages.find(message => message.type === 'sendMessage').model), 'claude-code-opus');
});

test('provider-settings action opens Settings, and history identifies and searches workspaces', async t => {
	const page = await openSurface(t, 'chat', 420);
	await post(page, { type: 'showProviderSettings' });
	assert.equal(await page.getByRole('tab', { name: 'Settings tab', exact: true }).getAttribute('aria-selected'), 'true');
	await post(page, { type: 'historySnapshot', conversations: [
		{ id: 'a', title: 'Explain this file', workspaceName: 'Project Alpha', updatedAt: Date.now(), messageCount: 2 },
		{ id: 'b', title: 'Earlier work', updatedAt: Date.now(), messageCount: 1 },
	] });
	await page.getByRole('tab', { name: 'History tab', exact: true }).click();
	assert.match(await page.locator('#historyPaneList').textContent(), /Project Alpha/);
	assert.match(await page.locator('#historyPaneList').textContent(), /Earlier conversation/);
	await screenshot(page, 'workspace-history');
	await page.getByRole('searchbox', { name: 'Search Conversations…' }).fill('Project Alpha');
	assert.equal(await page.locator('.history-pane-row').count(), 1);
	await assertNoPageOverflow(page);
});

test('history workspace filters and searches persist, with clear filters and consistent New Chat actions', async t => {
	const snapshot = { type: 'historySnapshot', activeId: 'local', conversations: [
		{ id: 'local', title: 'Current task', inCurrentWorkspace: true, workspaceName: 'Current Project', updatedAt: Date.now(), messageCount: 1 },
		{ id: 'remote', title: 'Older task', inCurrentWorkspace: false, workspaceName: 'Other Project', updatedAt: Date.now(), messageCount: 2 },
	] };
	const page = await openSurface(t, 'chat', 400);
	await post(page, snapshot);
	await page.getByRole('tab', { name: 'History tab', exact: true }).click();
	await page.getByRole('button', { name: 'This Workspace', exact: true }).click();
	assert.equal(await page.locator('.history-pane-row').count(), 1);
	await page.getByRole('searchbox', { name: 'Search Conversations…' }).fill('Current task');
	await screenshot(page, 'history-workspace-filter');
	const reloaded = await openSurface(t, 'chat', 400, await page.evaluate(() => savedWebviewState));
	await post(reloaded, snapshot);
	await reloaded.getByRole('tab', { name: 'History tab', exact: true }).click();
	assert.equal(await reloaded.getByRole('searchbox', { name: 'Search Conversations…' }).inputValue(), 'Current task');
	assert.equal(await reloaded.getByRole('button', { name: 'This Workspace', exact: true }).getAttribute('aria-pressed'), 'true');
	await reloaded.getByRole('searchbox', { name: 'Search Conversations…' }).fill('Nothing matching');
	await reloaded.locator('#historyNoResults').waitFor({ state: 'visible' });
	await reloaded.getByRole('button', { name: 'Clear Filters', exact: true }).click();
	assert.equal(await reloaded.locator('.history-pane-row').count(), 2);
	assert.equal(await reloaded.locator('#historySearch').evaluate(input => input === document.activeElement), true);
	await reloaded.locator('#historyNewBtn').click();
	assert.equal(await reloaded.evaluate(() => sentMessages.at(-1).type), 'clearConversation');
	for (const width of [280, 400, 800]) { await reloaded.setViewportSize({ width, height: 900 }); await assertNoPageOverflow(reloaded); }
});

test('deleted conversations release their saved drafts without discarding the current draft', async t => {
	const page = await openSurface(t, 'chat', 400, { conversationDrafts: [['deleted', { text: 'Remove this draft' }]] });
	await page.locator('#messageInput').fill('Keep this draft');
	await post(page, { type: 'conversationDeleted', conversationId: 'deleted' });
	assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this draft');
	assert.equal(await page.evaluate(() => savedWebviewState.conversationDrafts.some(([id]) => id === 'deleted')), false);
});

test('board switching cancels assistant work, scopes actions, and clears unrelated task filters', async t => {
	const page = await openSurface(t, 'board', 1200);
	await post(page, fixture); await frames(page);
	await page.getByRole('searchbox', { name: 'Search tasks' }).fill('keyboard');
	await page.getByRole('button', { name: 'Ask Anton', exact: true }).click();
	await page.getByRole('textbox', { name: 'Message the board assistant' }).fill('Review the old plan');
	await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
	const request = await page.evaluate(() => sentMessages.find(message => message.type === 'chat-runtime'));
	assert.equal(request.conversationId, fixture.conversationId);
	await post(page, { ...fixture, conversationId: 'new-board', conversationTitle: 'A different project', snapshot: { ...fixture.snapshot, conversationId: 'new-board' } });
	await frames(page);
	assert.equal(await page.getByRole('searchbox', { name: 'Search tasks' }).inputValue(), '');
	assert.equal(await page.evaluate(id => sentMessages.some(message => message.type === 'cancel-chat' && message.requestId === id), request.requestId), true);
	await post(page, { type: 'chat-runtime-chunk', requestId: request.requestId, event: { type: 'tool-call', id: 'late', name: 'addCard', input: { instruction: 'Wrong project' } } });
	assert.equal(await page.evaluate(() => sentMessages.some(message => message.type === 'board-action')), false);
	assert.equal(await page.getByRole('region', { name: 'Board conversation' }).textContent().then(text => text.includes('Review the old plan')), false);
	await page.getByRole('textbox', { name: 'Message the board assistant' }).fill('Review this plan');
	await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
	const current = await page.evaluate(() => sentMessages.filter(message => message.type === 'chat-runtime').at(-1));
	await post(page, { type: 'chat-runtime-chunk', requestId: current.requestId, event: { type: 'tool-call', id: 'current', name: 'addCard', input: { instruction: 'Current task' } } });
	assert.equal(await page.evaluate(() => sentMessages.find(message => message.type === 'board-action').conversationId), 'new-board');
});

test('context: preview real host context, ignore stale updates, and send the per-conversation setting', async t => {
	const page = await openSurface(t, 'chat', 420);
	await page.locator('#workspaceContextDetails summary').click();
	await page.waitForFunction(() => sentMessages.some(message => message.type === 'previewWorkspaceContext'));
	await post(page, { type: 'workspaceContextPreview', conversationId: 'initial-conversation', markdown: '## Workspace Context\n\n**Active File:** src/editor.ts\n\nSelection: lines 20–36', estimatedTokens: 72 });
	assert.match(await page.locator('#workspaceContextPreview').textContent(), /src\/editor.ts/);
	await screenshot(page, 'context-preview');
	await page.getByRole('checkbox', { name: 'Include Workspace Context' }).uncheck();
	await post(page, { type: 'workspaceContextPreview', conversationId: 'initial-conversation', markdown: 'LATE CONTEXT', estimatedTokens: 5 });
	assert.doesNotMatch(await page.locator('#workspaceContextPreview').textContent(), /LATE/);
	await page.locator('#messageInput').fill('Explain this concept without my workspace');
	await page.locator('#messageInput').press('Enter');
	assert.equal(await page.evaluate(() => sentMessages.find(message => message.type === 'sendMessage').includeWorkspaceContext), false);
	await post(page, { type: 'messageComplete' });
	await post(page, { type: 'loadConversation', conversationId: 'second', messages: [] });
	assert.equal(await page.getByRole('checkbox', { name: 'Include Workspace Context' }).isChecked(), true);
	await post(page, { type: 'workspaceContextPreview', conversationId: 'initial-conversation', markdown: 'OLD WORKSPACE', estimatedTokens: 5 });
	assert.doesNotMatch(await page.locator('#workspaceContextPreview').textContent(), /OLD WORKSPACE/);
});

test('streaming: drafting a follow-up cannot accidentally stop the current response', async t => {
	const page = await openSurface(t, 'chat', 420);
	await page.locator('#messageInput').fill('Start a task');
	await page.locator('#messageInput').press('Enter');
	await post(page, { type: 'streamToken', token: 'Working on the task…' });
	await page.locator('#messageInput').fill('A follow-up for later');
	await page.locator('#messageInput').press('Enter');
	assert.equal(await page.evaluate(() => sentMessages.some(message => message.type === 'cancelRequest')), false);
	await page.locator('#sendBtn').click();
	assert.equal(await page.evaluate(() => sentMessages.some(message => message.type === 'cancelRequest')), true);
	await post(page, { type: 'requestSettled', cancelled: true });
	await page.getByText('Response Stopped', { exact: true }).waitFor();
	assert.equal((await page.locator('#messageInput').inputValue()).trim(), 'A follow-up for later');
	assert.equal(await page.locator('#sendBtn').getAttribute('aria-label'), 'Send');
});

test('settings: all sections hydrate, support keyboard navigation and dispatch every editable setting', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.getByRole('tab', { name: 'Settings tab', exact: true }).click();
	assert.equal(await page.evaluate(() => sentMessages.some(m => m.type === 'requestSettings') && sentMessages.some(m => m.type === 'requestMcpServers')), true);
	await post(page, { type: 'settingsState', version: '1.2.3', settings: { 'sota.defaultModel': 'gpt-5', 'sota.thinkingBudgetTokens': 16000 } });
	await page.getByRole('tab', { name: 'API Configuration', exact: true }).focus();
	for (const id of ['models', 'specialists', 'features', 'personality', 'mcp', 'integrations', 'terminal', 'about']) {
		await page.keyboard.press('ArrowRight');
		assert.equal(await page.locator('#settingsTab-' + id).getAttribute('aria-selected'), 'true');
		await assertNoPageOverflow(page);
	}
	assert.equal(await page.locator('#settingsAboutVersion').textContent(), 'Version: 1.2.3');
	await page.locator('[data-action="reset-all-settings"]').click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'resetAllSettings');
	for (const id of ['models', 'features', 'personality', 'terminal']) {
		await page.locator('#settingsTab-' + id).click();
		const pane = page.locator('#settingsSubtab-' + id);
		for (const input of await pane.locator('input[data-setting]').all()) {
			await input.setChecked(!(await input.isChecked()));
			assert.equal(await page.evaluate(() => sentMessages.at(-1).settingId), await input.getAttribute('data-setting'));
		}
		for (const select of await pane.locator('select[data-setting-select]').all()) {
			const options = await select.locator('option').evaluateAll(nodes => nodes.map(n => n.value));
			assert.ok(options.length > 1);
			await select.selectOption(options.at(-1));
			assert.equal(await page.evaluate(() => sentMessages.at(-1).settingId), await select.getAttribute('data-setting-select'));
		}
		for (const input of await pane.locator('input[type="range"]').all()) {
			await input.focus(); await input.press('ArrowRight');
			assert.equal(await page.evaluate(() => sentMessages.at(-1).settingId), await input.getAttribute('data-setting-number'));
		}
		for (const input of await pane.locator('input[type="number"], textarea[data-setting-text]').all()) {
			await input.fill((await input.getAttribute('type')) === 'number' ? '2' : '^dangerous-command$');
			await input.press('Tab');
			assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'settingChange');
		}
	}
	await page.locator('#settingsTab-mcp').click();
	await post(page, { type: 'mcpServersState', servers: [{ name: 'fixture', command: 'node', args: ['server.js'] }] });
	await page.locator('#settingsMcpServers [data-action="edit"]').click();
	await page.locator('#mcpFld-command').fill('python');
	await page.locator('#settingsMcpServers [data-action="save"]').click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'mcpServerSave');
	await post(page, { type: 'mcpServerSaveResult', ok: true, message: 'Saved' });
	await page.locator('#settingsMcpServers [data-action="delete"]').click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'mcpServerDelete', name: 'fixture' });
	await page.locator('#settingsTab-features').click();
	await screenshot(page, 'settings-features');
});

test('roster and specialist models: every specialist can be selected and every model override is wired', async t => {
	const page = await openSurface(t, 'chat', 360);
	await page.getByRole('tab', { name: 'Roster tab', exact: true }).click();
	const labels = await page.getByRole('button', { name: /^Talk to @/ }).allTextContents();
	assert.equal(labels.length, 10);
	for (const label of labels) {
		await page.getByRole('button', { name: label, exact: true }).click();
		assert.equal(await page.getByRole('tab', { name: 'Chat tab', exact: true }).getAttribute('aria-selected'), 'true');
		await page.getByRole('tab', { name: 'Roster tab', exact: true }).click();
	}
	await screenshot(page, 'roster');
	await page.getByRole('tab', { name: 'Settings tab', exact: true }).click();
	await page.locator('#settingsTab-specialists').click();
	await post(page, { type: 'specialistModelsState', entries: labels.map(label => ({ handle: label.replace('Talk to @', ''), displayName: label, defaultModel: 'sonnet', value: '', pinned: false })) });
	for (const select of await page.locator('.specialist-row-model').all()) {
		await select.selectOption('haiku');
		assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'setSpecialistModel');
	}
	await page.locator('#specialistModelsReload').click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'reloadWindow');
	await assertNoPageOverflow(page);
	await screenshot(page, 'settings-specialists');
});

test('provider configuration: every provider form supports help, advanced fields, test, save and return', async t => {
	const page = await openSurface(t, 'chat', 400);
	await post(page, { type: 'connectionState', status: { providers: [], apiKeys: {} } });
	await page.getByRole('tab', { name: 'Settings tab', exact: true }).click();
	const providers = await page.locator('[data-settings-provider]').evaluateAll(nodes => nodes.map(n => n.dataset.settingsProvider));
	assert.equal(providers.length, 14);
	for (const provider of providers) {
		await page.locator(`[data-settings-provider="${provider}"]`).click();
		const form = page.locator('.provider-form:visible');
		for (const link of await form.locator('a[data-link]').all()) { await link.click(); }
		assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'openLink');
		if (await form.locator('summary').count()) { await form.locator('summary').click(); }
		for (const input of await form.locator('input:visible').all()) { await input.fill((await input.getAttribute('type')) === 'number' ? '1' : 'ui-fixture'); }
		await form.locator('[data-action="test-connection"]').click();
		assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'providerTest');
		await post(page, { type: 'providerTestResult', provider, ok: false, message: 'Fixture connection failed' });
		await form.locator('[data-action="save"]').click();
		const count = await page.evaluate(() => sentMessages.filter(m => m.type === 'providerSave').length);
		await form.locator('input').first().press('Enter');
		assert.equal(await page.evaluate(() => sentMessages.filter(m => m.type === 'providerSave').length), count, 'Enter cannot submit twice while saving');
		await post(page, { type: 'providerSaveResult', provider, ok: false, message: 'Fixture validation failed' });
		assert.match(await form.locator('[data-form-status]').textContent(), /validation failed/);
		await assertNoPageOverflow(page);
		await form.locator('[data-action="back"]').first().click();
		assert.equal(await page.getByRole('tab', { name: 'Settings tab', exact: true }).getAttribute('aria-selected'), 'true');
	}
	await screenshot(page, 'settings-providers');
});

test('integrations: search, filtering, pagination, connection updates and error recovery', async t => {
	const page = await openSurface(t, 'chat', 320);
	await page.getByRole('tab', { name: 'Settings tab', exact: true }).click();
	await page.locator('#settingsTab-integrations').click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).integrationAction), 'list');
	const state = { entries: Array.from({ length: 55 }, (_, index) => ({ id: `skill-${index}`, kind: 'skill', name: `Skill ${index}`, source: 'codex', scope: 'user', description: 'Installed skill', enabled: true, configured: false })), issues: [{ path: '/fixture/config.toml', message: 'Could not parse configuration.' }] };
	state.entries.push({ id: 'mcp-1', kind: 'mcp', name: 'Local MCP', source: 'claude', scope: 'user', description: 'MCP server', enabled: true, configured: false });
	state.entries.push({ id: 'plugin-1', kind: 'plugin', name: 'Cached Plugin', source: 'cursor', scope: 'user', description: 'Plugin', enabled: false, configured: false, reason: 'Cached or disabled in source application' });
	await post(page, { type: 'systemIntegrationsState', state });
	assert.equal(await page.locator('.integration-card').count(), 50);
	await page.locator('#integrationMore').click();
	assert.equal(await page.locator('.integration-card').count(), 57);
	await page.locator('#integrationSearch').fill('cached');
	assert.equal(await page.locator('.integration-card').count(), 1);
	assert.match(await page.locator('.integration-card').textContent(), /Cached or disabled/);
	await page.locator('#integrationSearch').fill('');
	await page.locator('#integrationKind').selectOption('mcp');
	await page.getByRole('button', { name: 'Connect', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'systemIntegrations', integrationAction: 'connect', integrationId: 'mcp-1' });
	const pendingRequests = await page.evaluate(() => sentMessages.length);
	await page.getByRole('button', { name: 'Connect', exact: true }).dispatchEvent('click');
	assert.equal(await page.evaluate(() => sentMessages.length), pendingRequests);
	state.entries[55].configured = true; state.entries[55].state = 'ready';
	await post(page, { type: 'systemIntegrationsState', state });
	assert.match(await page.locator('.integration-card').textContent(), /Connected/);
	assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Disconnect');
	await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).integrationAction), 'disconnect');
	state.entries[55].configured = false; delete state.entries[55].state;
	await post(page, { type: 'systemIntegrationsState', state });
	await page.getByRole('button', { name: 'Show Source', exact: true }).click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).integrationAction), 'open');
	await post(page, { type: 'systemIntegrationsState', state });
	await assertNoPageOverflow(page);
	await screenshot(page, 'integrations-narrow');
	await post(page, { type: 'systemIntegrationsChanged' });
	assert.equal(await page.evaluate(() => sentMessages.at(-1).integrationAction), 'list');
	await post(page, { type: 'systemIntegrationsState', error: 'Discovery unavailable. Refresh to try again.' });
	assert.match(await page.locator('#integrationStatus').textContent(), /Discovery unavailable/);
	await page.locator('#integrationRefresh').click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).integrationAction), 'refresh');
	await post(page, { type: 'systemIntegrationsState', state });
	assert.match(await page.locator('#integrationStatus').textContent(), /1 integrations/);
});

test('specialist models: ACP routes show their owning agent instead of an ineffective model picker', async t => {
	const specialists = SPECIALIST_ROLES.map(role => ({ ...role, acpAgent: role.id === 'anton-docs' ? 'local-anton-docs' : '' }));
	const page = await openSurface(t, 'chat', 320, undefined, undefined, specialists);
	await post(page, { type: 'loadConversation', conversationId: 'acp-model', lastSpecialist: 'anton-docs', messages: [] });
	assert.equal(await page.locator('#modelChip').isDisabled(), true);
	assert.match(await page.locator('#modelChip').textContent(), /Managed by ACP/);
	assert.match(await page.locator('#modelChip').getAttribute('title'), /local-anton-docs/);
	await post(page, { type: 'loadConversation', conversationId: 'native-model', lastSpecialist: 'anton', messages: [] });
	assert.equal(await page.locator('#modelChip').isEnabled(), true);
	assert.match(await page.locator('#modelChip').textContent(), /Sonnet/);
	await page.getByRole('tab', { name: 'Settings tab', exact: true }).click();
	await page.locator('#settingsTab-specialists').click();
	await post(page, { type: 'specialistModelsState', entries: [{ handle: 'anton-docs', displayName: 'Anton Docs', defaultModel: 'haiku', value: 'sonnet', pinned: true, acpAgent: 'local-anton-docs' }] });
	const model = page.getByRole('combobox', { name: 'Model for @anton-docs' });
	assert.equal(await model.isDisabled(), true);
	assert.equal(await model.textContent(), 'local-anton-docs');
	assert.match(await page.locator('.specialist-row-status').textContent(), /Managed by ACP/);
	await assertNoPageOverflow(page);
});

test('history restores the selected specialist and retains each response author and unavailable usage', async t => {
	const page = await openSurface(t, 'chat', 360);
	await post(page, { type: 'loadConversation', conversationId: 'restored-docs', lastSpecialist: 'anton-docs', lastMode: 'act', messages: [
		{ role: 'user', content: 'Review this example.' },
		{ role: 'assistant', content: 'Code review.', specialistId: 'anton-code' },
		{ role: 'assistant', content: 'Documentation review.', specialistId: 'anton-docs', usageUnavailable: true },
	] });
	assert.deepEqual(await page.locator('.msg-specialist-name').allTextContents(), ['Anton Code', 'Anton Docs']);
	assert.match(await page.locator('#agentChip').textContent(), /Anton Docs/);
	await post(page, { type: 'costReset' });
	await post(page, { type: 'costUpdate', tokens: 0, dollars: 0, inputTokens: 0, outputTokens: 0 });
	assert.match(await page.locator('#transcriptTaskMeter').textContent(), /Usage Unavailable/);
	await page.locator('#messageInput').fill('Continue the documentation review.');
	await page.locator('#sendBtn').click();
	assert.equal(await page.evaluate(() => sentMessages.findLast(message => message.type === 'sendMessage').specialistId), 'anton-docs');
});

async function openCouncil(t, width = 1100, state) {
	const source = await readFile(path.join(extension, 'src/council/CouncilPanel.ts'), 'utf8');
	const labels = Object.fromEntries([...source.matchAll(/(?:'([^']+)'|(\w+)): vscode\.l10n\.t\('([^']*)'\)/g)].map(match => [match[1] || match[2], match[3]]));
	const values = { nonce: 'ui-fixture', script: 'https://sota.test/council.js', css: 'https://sota.test/council.css', 'webview.cspSource': 'https://sota.test', labels: JSON.stringify(labels) };
	const html = source.slice(source.indexOf('return /* html */`<!DOCTYPE html>')).split('`')[1].replace(/\$\{([^}]+)\}/g, (_, name) => values[name]);
	return openSurface(t, 'council', width, state, html);
}
const councilGroup = { id: 'review', name: 'Change Review', members: [{ id: 'code' }, { id: 'tests' }, { id: 'security' }], quorum: 2, concurrency: 2, rounds: 1, runTimeoutMs: 600000, reviewer: { id: 'reviewer' } };
const councilReport = { version: 1, id: 'report-1', sequence: 2, owned: true, objective: 'Review the parser', group: councilGroup, createdAt: 1, status: 'running', snapshot: { base: 'a'.repeat(40), head: 'b'.repeat(40), digest: 'c'.repeat(64), limitations: ['Tracked diff only'] }, stages: [{ id: 'member-code', kind: 'member', round: 1, member: { label: 'Code Reviewer', model: 'sonnet' }, status: 'running', text: '<img src=x onerror="window.unsafe = true"> partial evidence' }] };

test('Council form, progress, cancellation, evidence, export, promotion and restored reports work under CSP', async t => {
	const page = await openCouncil(t);
	assert.equal(await page.locator('#start').isDisabled(), true);
	await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://untrusted.invalid', source: window.parent, data: { type: 'councilState', error: 'Forged host message' } })));
	assert.equal(await page.getByText('Forged host message').count(), 0);
	await post(page, { type: 'councilState', groups: [councilGroup], reports: [] });
	await page.locator('#objective').fill('Audit parser changes'); await page.locator('#revision').fill('HEAD~1'); await page.locator('#finalReview').check(); await page.locator('#start').click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'start', objective: 'Audit parser changes', groupId: 'review', revision: 'HEAD~1', rounds: 1, finalReview: true });
	await post(page, { type: 'councilState', groups: [councilGroup], reports: [councilReport], selected: 'report-1' });
	assert.equal(await page.locator('#report img').count(), 0); assert.equal(await page.locator('#start').isDisabled(), true);
	await page.getByRole('button', { name: 'Cancel Review', exact: true }).click(); assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'cancel');
	const completed = { ...councilReport, sequence: 3, status: 'completed', stages: [{ ...councilReport.stages[0], status: 'completed', answer: { summary: 'A bounds check is missing.', findings: [{ title: 'Missing guard', severity: 'medium', file: 'src/parser.ts', line: 4, evidence: 'const n = input.length;', detail: 'Undefined input throws before validation.' }], dissent: ['The current test does not cover undefined.'], questions: ['Is undefined supported?'] } }] };
	await post(page, { type: 'councilReport', report: completed });
	await page.getByRole('button', { name: 'Open Evidence', exact: true }).click(); assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'evidence', id: 'report-1', stageId: 'member-code', index: 0 });
	await page.getByRole('button', { name: 'Add Findings to Board', exact: true }).click(); assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'promote');
	await page.getByRole('button', { name: 'Export Markdown', exact: true }).focus();
	await post(page, { type: 'councilReport', report: { ...completed, sequence: 4 } });
	assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Export Markdown');
	await page.getByRole('button', { name: 'Export Markdown', exact: true }).click(); assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'export');
	await post(page, { type: 'councilReport', report: councilReport }); assert.equal(await page.getByRole('button', { name: 'Cancel Review', exact: true }).count(), 0);
	await page.getByRole('button', { name: 'Refresh', exact: true }).click(); assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'ready');
	await page.getByRole('button', { name: 'Edit Groups', exact: true }).click(); assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'groups');
	await assertNoPageOverflow(page);
	if (process.env.SOTA_UI_SCREENSHOTS) { await page.screenshot({ path: path.join(process.env.SOTA_UI_SCREENSHOTS, 'council-review.png'), fullPage: true }); }
});

test('Council narrow panes preserve error recovery, partial results and keyboard controls', async t => {
	const page = await openCouncil(t, 320);
	await post(page, { type: 'councilState', groups: [councilGroup], reports: [{ ...councilReport, status: 'quorum-failed', error: 'Only one member completed. Partial work is preserved.', stages: [{ ...councilReport.stages[0], status: 'failed', error: 'Provider disconnected' }] }] });
	await page.getByText('Partial / Raw Response', { exact: true }).click();
	assert.match(await page.locator('#report').textContent(), /Quorum Not Reached/); await assertNoPageOverflow(page);
	await post(page, { type: 'councilState', error: 'Invalid saved group. Edit Groups to repair it.' }); assert.match(await page.getByRole('alert').textContent(), /Invalid saved group/);
	await page.getByRole('button', { name: 'Edit Groups', exact: true }).focus(); await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => sentMessages.at(-1).type), 'groups');
	if (process.env.SOTA_UI_SCREENSHOTS) { await page.screenshot({ path: path.join(process.env.SOTA_UI_SCREENSHOTS, 'council-narrow.png'), fullPage: true }); }
});

test('Council restores setup drafts and loads report detail only when its history row is selected', async t => {
	const page = await openCouncil(t, 1100, { objective: 'Keep my review draft', revision: 'HEAD~2', rounds: '2', groupId: 'review', finalReview: true });
	const summary = { id: 'older', sequence: 3, status: 'completed', objective: 'Earlier review', createdAt: 0 };
	await post(page, { type: 'councilState', groups: [councilGroup], reports: [councilReport, summary] });
	assert.deepEqual(await page.evaluate(() => ['objective', 'revision', 'rounds'].map(id => document.getElementById(id).value)), ['Keep my review draft', 'HEAD~2', '2']);
	await page.getByRole('button', { name: /Earlier review/ }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'select', id: 'older' });
	assert.match(await page.locator('#report').textContent(), /Loading Council reports/);
	await post(page, { type: 'councilReport', report: { ...councilReport, ...summary } });
	assert.equal(await page.locator('#report h2').textContent(), 'Earlier review');
	await post(page, { type: 'councilState', reports: [summary] });
	assert.equal(await page.locator('#report h2').textContent(), 'Earlier review');
	assert.equal(await page.evaluate(() => savedWebviewState.objective), 'Keep my review draft');
});

test('large boards render bounded columns and keep later cards searchable', async t => {
	const page = await openSurface(t, 'board');
	const large = { ...fixture, snapshot: { ...fixture.snapshot, tasks: Array.from({ length: 2000 }, (_, index) => ({ ...fixture.snapshot.tasks[1], id: `large-${index}`, instruction: `Task number ${index}` })) } };
	await post(page, large); await frames(page);
	assert.equal(await page.locator('.tile').count(), 50);
	await page.getByRole('button', { name: 'Show More (1950 remaining)' }).click();
	assert.equal(await page.locator('.tile').count(), 100);
	await page.getByRole('searchbox', { name: 'Search tasks', exact: true }).fill('Task number 1999');
	assert.equal(await page.locator('.tile').count(), 1);
	await page.getByRole('button', { name: 'Run Task', exact: true }).click();
	assert.ok((await page.evaluate(() => window.sentMessages)).some(message => message.type === 'dispatch' && message.taskId === 'large-1999'));
});

test('long chat paging preserves turn indices, live messages and checkpoint controls', async t => {
	const page = await openSurface(t, 'chat', 420);
	const messages = Array.from({ length: 2000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Message ${index}`, timestamp: index + 1 }));
	await post(page, { type: 'loadConversation', conversationId: 'long', messages }); await frames(page);
	assert.equal(await page.locator('.msg').count(), 200);
	assert.equal(await page.locator('.msg').first().getAttribute('data-conversation-index'), '1800');
	await page.getByRole('button', { name: 'Show Earlier Messages (1800)' }).click();
	assert.equal(await page.locator('.msg').count(), 300);
	assert.equal(await page.locator('.msg').first().getAttribute('data-conversation-index'), '1700');
	assert.equal(await page.locator('.msg').last().getAttribute('data-conversation-index'), '1999');
	await post(page, { type: 'conversationCleared', conversationId: 'new' });
	assert.equal(await page.getByRole('button', { name: /Show Earlier Messages/ }).count(), 0);
});

test('Council task review, cancellation and retry route through the native host', async t => {
	const page = await openSurface(t, 'board');
	const instruction = 'Fix inverted clamp bounds\n\n' + 'Preserve the detailed evidence for review. '.repeat(100);
	await post(page, { ...fixture, snapshot: { ...fixture.snapshot, tasks: [{ ...fixture.snapshot.tasks[5], instruction, id: 'council:fixture', proposalId: 'retained' }] } }); await frames(page);
	assert.equal(await page.locator('.tile-instruction').textContent(), 'Fix inverted clamp bounds');
	assert.ok((await page.locator('.tile').boundingBox()).height < 450);
	await page.locator('.tile-instruction').click();
	assert.equal(await page.locator('.task-full-instruction').textContent(), instruction);
	await page.locator('.tile-instruction').click();
	await page.getByRole('button', { name: 'Review Changes' }).click(); await page.getByRole('button', { name: 'Retry', exact: true }).click();
	await post(page, { ...fixture, snapshot: { ...fixture.snapshot, tasks: [{ ...fixture.snapshot.tasks[5], state: 'in-progress', id: 'council:fixture', proposalId: 'retained' }] } }); await frames(page);
	await page.getByRole('button', { name: 'Cancel Task' }).click();
	assert.deepEqual((await page.evaluate(() => window.sentMessages)).filter(message => ['review-proposal', 'rerun', 'cancel-task'].includes(message.type)), [{ type: 'review-proposal', taskId: 'council:fixture', conversationId: fixture.conversationId }, { type: 'rerun', taskId: 'council:fixture', conversationId: fixture.conversationId }, { type: 'cancel-task', taskId: 'council:fixture', conversationId: fixture.conversationId }]);
});

test('board dependency planner validates cycles and previews a scoped scheduling change', async t => {
	const page = await openSurface(t, 'board', 1200);
	const tasks = [
		{ ...fixture.snapshot.tasks[1], id: 'foundation', instruction: 'Build foundation', dependencies: [], state: 'ready' },
		{ ...fixture.snapshot.tasks[1], id: 'interface', instruction: 'Build interface', dependencies: ['foundation'], state: 'backlog' },
		{ ...fixture.snapshot.tasks[1], id: 'tests', instruction: 'Add tests', dependencies: ['foundation'], state: 'backlog' },
	];
	await post(page, { ...fixture, snapshot: { ...fixture.snapshot, tasks } }); await frames(page);
	await page.getByRole('button', { name: 'Dependencies', exact: true }).click();
	await page.getByRole('checkbox', { name: /Build interface/ }).check();
	assert.match(await page.getByRole('alert').textContent(), /cycle/);
	assert.equal(await page.getByRole('button', { name: 'Apply Dependencies' }).isDisabled(), true);
	await page.getByRole('combobox', { name: 'Task to edit dependencies' }).selectOption('tests');
	await page.getByRole('checkbox', { name: /Build interface/ }).check();
	assert.equal(await page.getByRole('heading', { name: 'Wave 3', exact: true }).count(), 1);
	await page.getByRole('button', { name: 'Apply Dependencies' }).click();
	const message = await page.evaluate(() => sentMessages.find(message => message.type === 'set-dependencies'));
	assert.deepEqual({ id: message.taskId, dependencies: message.dependencies, conversation: message.conversationId }, { id: 'tests', dependencies: ['foundation', 'interface'], conversation: fixture.conversationId });
	assert.ok(message.expectedRevision.includes('foundation'));
});

test('dependency drafts reset atomically when switching tasks or receiving a new board revision', async t => {
	const page = await openSurface(t, 'board', 1200);
	const tasks = [
		{ ...fixture.snapshot.tasks[1], id: 'foundation', instruction: 'Build foundation', dependencies: [], state: 'ready' },
		{ ...fixture.snapshot.tasks[1], id: 'interface', instruction: 'Build interface', dependencies: ['foundation'], state: 'backlog' },
		{ ...fixture.snapshot.tasks[1], id: 'tests', instruction: 'Add tests', dependencies: ['foundation'], state: 'backlog' },
	];
	await post(page, { ...fixture, snapshot: { ...fixture.snapshot, tasks } }); await frames(page);
	await page.getByRole('button', { name: 'Dependencies', exact: true }).click();
	const select = page.getByRole('combobox', { name: 'Task to edit dependencies' });
	const interfaceBox = page.getByRole('checkbox', { name: /Build interface/ });
	const foundationBox = page.getByRole('checkbox', { name: /Build foundation/ });
	const apply = page.getByRole('button', { name: 'Apply Dependencies' });
	for (let iteration = 0; iteration < 6; iteration++) {
		await select.selectOption('foundation'); await interfaceBox.check();
		await select.focus(); await select.selectOption('tests');
		assert.deepEqual({ focused: await select.evaluate(element => element === document.activeElement), foundation: await foundationBox.isChecked(), interface: await interfaceBox.isChecked(), applyDisabled: await apply.isDisabled() }, { focused: true, foundation: true, interface: false, applyDisabled: true });
		await interfaceBox.check(); await apply.click();
	}
	const requests = await page.evaluate(() => sentMessages.filter(message => message.type === 'set-dependencies'));
	assert.equal(requests.length, 6);
	assert.ok(requests.every(message => message.taskId === 'tests' && JSON.stringify(message.dependencies) === JSON.stringify(['foundation', 'interface'])));
	await post(page, { ...fixture, snapshot: { ...fixture.snapshot, tasks: tasks.map(task => task.id === 'tests' ? { ...task, dependencies: [] } : task) } }); await frames(page);
	assert.deepEqual({ selected: await select.inputValue(), foundation: await foundationBox.isChecked(), interface: await interfaceBox.isChecked(), applyDisabled: await apply.isDisabled() }, { selected: 'tests', foundation: false, interface: false, applyDisabled: true });
	await post(page, { ...fixture, snapshot: { ...fixture.snapshot, tasks: tasks.slice(0, 2) } }); await frames(page);
	assert.deepEqual({ selected: await select.inputValue(), interface: await interfaceBox.isChecked(), applyDisabled: await apply.isDisabled() }, { selected: 'foundation', interface: false, applyDisabled: true });
	await post(page, { ...fixture, snapshot: { ...fixture.snapshot, tasks: tasks.slice(0, 2).map(task => task.id === 'foundation' ? { ...task, state: 'in-progress' } : task) } }); await frames(page);
	assert.equal(await interfaceBox.isDisabled(), true);
});

test('bounded timeline evicts both ends while preserving response drafts, votes and checkpoints', async t => {
	const page = await openSurface(t, 'chat', 420);
	const messages = Array.from({ length: 1000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Message ${index}`, timestamp: index + 1, ...(index % 2 ? { responseId: `saved-${index}` } : { request: { text: `Prompt ${index}`, attachments: ['terminal-output'], includeWorkspaceContext: false } }) }));
	await post(page, { type: 'loadConversation', conversationId: 'windowed', messages }); await frames(page);
	await post(page, { type: 'checkpointsLoaded', checkpoints: [{ checkpointId: 'older-checkpoint', turnIndex: 0, capturedAt: Date.now(), summary: 'Before first turn' }] });
	const first = page.locator('.msg[data-conversation-index="0"]');
	while (await first.count() === 0) {
		await page.getByRole('button', { name: /Show Earlier Messages/ }).click(); await frames(page);
		assert.ok(await page.locator('.msg').count() <= 300);
	}
	assert.equal(await page.locator('.checkpoint-stripe[data-checkpoint-id="older-checkpoint"]').count(), 1);
	const response = page.locator('.msg[data-conversation-index="1"]');
	await response.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).click();
	await page.getByRole('button', { name: 'Jump to Latest Messages', exact: true }).click(); await frames(page);
	assert.equal(await first.count(), 0);
	assert.equal(await page.locator('.msg').first().getAttribute('data-conversation-index'), '700');
	while (await first.count() === 0) { await page.getByRole('button', { name: /Show Earlier Messages/ }).click(); await frames(page); }
	assert.equal(await response.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).getAttribute('aria-pressed'), 'true');
	await response.getByRole('button', { name: 'Reuse Prompt', exact: true }).click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'Prompt 0');
	assert.match(await page.locator('#contextChips').innerText(), /Terminal output/);
	assert.equal(await page.locator('#includeWorkspaceContext').isChecked(), false);
	await page.locator('.checkpoint-stripe[data-checkpoint-id="older-checkpoint"] button').click();
	await page.getByRole('menuitem', { name: 'Compare with current', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'checkpointCompare', checkpointId: 'older-checkpoint' });
	await page.getByRole('button', { name: /Show Newer Messages/ }).click(); await frames(page);
	assert.equal(await page.locator('.msg').first().getAttribute('data-conversation-index'), '100');
	assert.equal(await page.locator('.msg').count(), 300);
	assert.equal(await page.locator('.msg').evaluateAll(nodes => new Set(nodes.map(node => node.dataset.conversationIndex)).size), 300);
	await assertNoPageOverflow(page);
});

test('bounded timeline pins a streaming turn and restores its original Markdown after eviction', async t => {
	const page = await openSurface(t, 'chat', 420);
	const messages = Array.from({ length: 800 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Message ${index}`, timestamp: index + 1 }));
	await post(page, { type: 'loadConversation', conversationId: 'live-window', messages }); await frames(page);
	await page.locator('#messageInput').fill('Keep the active response'); await page.locator('#sendBtn').click();
	await post(page, { type: 'streamToken', token: '## Live result\n\n```ts\nconst answer = 42;' }); await frames(page);
	const live = page.locator('.msg[data-conversation-index="801"]');
	await live.evaluate(node => { window.liveTimelineNode = node; });
	for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
		await page.getByRole('button', { name: /Show Earlier Messages/ }).click(); await frames(page);
		assert.ok(await page.locator('.msg').count() <= 300);
		assert.equal(await live.evaluate(node => node === window.liveTimelineNode), true);
		assert.equal(await page.locator('.msg[data-conversation-index="800"]').count(), 1);
	}
	await post(page, { type: 'streamToken', token: '\n```\n\n**Finished**.' }); await frames(page);
	assert.equal(await live.locator('pre code').textContent(), 'const answer = 42;');
	assert.equal(await live.locator('strong').textContent(), 'Finished');
	await post(page, { type: 'messageComplete', totalTokens: 20 }); await frames(page);
	assert.equal(await live.count(), 0, 'A completed response leaves the pinned set while reading old messages');
	await page.getByRole('button', { name: 'Jump to Latest Messages', exact: true }).click(); await frames(page);
	assert.equal(await live.locator('pre code').textContent(), 'const answer = 42;');
	assert.equal(await live.locator('strong').textContent(), 'Finished');
	await live.getByRole('button', { name: 'Reuse Prompt', exact: true }).click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'Keep the active response');
	assert.ok(await page.locator('.msg').count() <= 300);
	await post(page, { type: 'conversationCleared', conversationId: 'clean' }); await frames(page);
	assert.equal(await page.locator('.msg').count(), 0);
	assert.equal(await page.locator('.timeline-navigation').count(), 0);
	await page.locator('#messageInput').fill('New conversation'); await page.locator('#sendBtn').click(); await frames(page);
	assert.equal(await page.locator('.msg-user').getAttribute('data-conversation-index'), '0');
});

test('provider discovery searches the complete catalog and distinguishes catalog access from inference verification', async t => {
	const page = await openSurface(t, 'chat', 400);
	const models = Array.from({ length: 180 }, (_, index) => ({ id: `catalog:fixture:model-${index}`, model: `model-${index}`, label: `Fixture Model ${index}`, chat: true }));
	await post(page, { type: 'providerCatalog', snapshot: { updatedAt: Date.now(), software: [{ name: 'Fixture CLI', installed: true, auth: 'file-present', configFiles: ['/fixture/config.json'] }], providers: [
		{ id: 'fixture', name: 'Fixture Cloud', credentialSource: 'environment', catalogStatus: 'available', inferenceStatus: 'not-verified', models },
		{ id: 'offline', name: 'Local Offline', credentialSource: 'none', catalogStatus: 'unreachable', inferenceStatus: 'not-verified', models: [], error: 'Local service is not running.' },
	] } });
	await page.locator('#modelChip').click();
	assert.equal(await page.locator('[data-model][data-discovered]').count(), 100);
	await page.locator('#modelSearch').fill('Fixture Model 179');
	assert.equal(await page.locator('[data-model][data-discovered]:visible').count(), 1);
	await page.locator('#modelSearch').press('Enter');
	assert.match(await page.locator('#modelChip').innerText(), /Fixture Model 179/);
	await page.getByRole('tab', { name: 'Settings tab', exact: true }).click();
	await page.locator('.provider-discovery summary').first().click();
	const status = await page.locator('#providerDiscoveryStatus').innerText();
	assert.match(status, /Fixture Cloud[\s\S]*available[\s\S]*180[\s\S]*not verified/);
	assert.match(status, /Local Offline[\s\S]*unreachable[\s\S]*Local service is not running/);
	await page.getByText('Detected Coding Tools', { exact: true }).click();
	assert.match(await page.locator('#providerDiscoveryStatus').innerText(), /Fixture CLI[\s\S]*Installed/);
	assert.doesNotMatch(await page.locator('#providerDiscoveryStatus').innerText(), /\/fixture\/config.json/);
	await assertNoPageOverflow(page); await screenshot(page, 'provider-discovery-sidebar');
});

test('provider catalogs isolate special object keys and retire removed picker metadata', async t => {
	const page = await openSurface(t, 'chat', 400);
	const model = { id: 'catalog:openai:fixture-safe', model: 'fixture-safe', label: 'Safe Catalog Model', chat: true };
	const snapshot = models => ({ updatedAt: Date.now(), software: [], providers: [{ id: 'openai', name: 'OpenAI', credentialSource: 'environment', catalogStatus: 'ready', inferenceStatus: 'not-verified', models }] });
	const metadata = JSON.parse('{"__proto__":{"blurb":"Injected prototype"},"constructor":{"blurb":"Injected constructor"},"sonnet":{"blurb":"Injected static metadata"}}');
	metadata[model.id] = { blurb: 'Catalog metadata', capabilities: [], pricingStatus: 'unknown' };
	await post(page, { type: 'providerCatalog', snapshot: snapshot([model, ...['__proto__', 'constructor', 'toString'].map(id => ({ ...model, id, label: `Injected ${id}` }))]), metadata });
	await page.locator('#modelChip').click();
	assert.equal(await page.locator('[data-model][data-discovered]').count(), 1);
	await page.locator('#modelSearch').fill('Safe Catalog Model'); await page.locator('#modelSearch').press('Enter');
	assert.match(await page.locator('#modelChip').innerText(), /Safe Catalog Model/);
	await post(page, { type: 'loadConversation', conversationId: 'catalog-selected', lastModel: model.id, messages: [] });
	assert.match(await page.locator('#modelChip').innerText(), /Safe Catalog Model/);
	for (const state of [{ catalogStatus: 'error' }, { catalogStatus: 'disabled' }, { catalogStatus: 'not-configured', configurationComplete: true }, { catalogStatus: 'ready', truncated: true }]) {
		const partial = snapshot([]); Object.assign(partial.providers[0], state);
		await post(page, { type: 'providerCatalog', snapshot: partial });
		assert.equal(await page.locator('#unavailableModelNotice').isVisible(), false);
		assert.equal(await page.locator('#sendBtn').isDisabled(), false);
	}
	await post(page, { type: 'providerCatalog', snapshot: snapshot([]), metadata: { [model.id]: metadata[model.id] } });
	await post(page, { type: 'loadConversation', conversationId: 'catalog-removed', lastModel: model.id, messages: [] });
	assert.match(await page.locator('#modelChip').innerText(), /catalog:openai:fixture-safe/);
	assert.equal(await page.locator('#unavailableModelNotice').isVisible(), true);
	await page.locator('#messageInput').fill('Preserve the chosen provider'); await page.locator('#messageInput').press('Enter');
	assert.equal(await page.locator('#sendBtn').isDisabled(), true);
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length), 0);
	await assertNoPageOverflow(page); await screenshot(page, 'unavailable-provider-model-sidebar');
	await page.locator('#modelChip').click();
	assert.equal(await page.locator('[data-model][data-discovered]').count(), 0);
	await page.locator('#modelSearch').fill('');
	await page.locator('[data-model="sonnet"]').focus();
	assert.doesNotMatch(await page.locator('.sota-model-tooltip').innerText(), /Injected/);
	assert.equal(await page.evaluate(() => Object.prototype.blurb), undefined);
	await page.locator('[data-model="sonnet"]').click();
	assert.equal(await page.locator('#unavailableModelNotice').isVisible(), false);
	assert.equal(await page.locator('#sendBtn').isDisabled(), false);
});

test('confirmed HTTP credential removal retires the selected model while missing evidence and lookup errors stay usable', async t => {
	const page = await openSurface(t, 'chat', 400);
	const model = { id: 'catalog:openai:credential-model', model: 'credential-model', label: 'Credential-backed model', chat: true };
	const snapshot = (models, state = {}) => ({ updatedAt: Date.now(), software: [], providers: [{ id: 'openai', name: 'OpenAI', credentialSource: 'setting', catalogStatus: 'ready', inferenceStatus: 'not-tested', models, ...state }] });
	const metadata = { [model.id]: { capabilities: ['text'], blurb: 'Credential-backed metadata', pricingStatus: 'unknown' } };
	await post(page, { type: 'providerCatalog', snapshot: snapshot([model]), metadata });
	await post(page, { type: 'loadConversation', conversationId: 'credential-removal', lastModel: model.id, messages: [] });
	assert.match(await page.locator('#modelChip').innerText(), /Credential-backed model/);
	for (const state of [
		{ credentialSource: 'none', catalogStatus: 'not-configured' },
		{ credentialSource: 'none', catalogStatus: 'error' },
		{ credentialSource: 'none', catalogStatus: 'error', credentialStatus: 'missing' },
		{ credentialSource: 'none', catalogStatus: 'disabled', credentialStatus: 'missing' },
		{ credentialSource: 'none', catalogStatus: 'not-configured', credentialStatus: 'missing', truncated: true },
	]) {
		await post(page, { type: 'providerCatalog', snapshot: snapshot([], state) });
		assert.deepEqual({ notice: await page.locator('#unavailableModelNotice').isVisible(), disabled: await page.locator('#sendBtn').isDisabled() }, { notice: false, disabled: false });
	}
	await post(page, { type: 'providerCatalog', snapshot: snapshot([], { credentialSource: 'none', catalogStatus: 'not-configured', credentialStatus: 'missing' }), metadata });
	await page.locator('#messageInput').fill('Preserve this draft after sign-out'); await page.locator('#messageInput').press('Enter');
	assert.deepEqual({ notice: await page.locator('#unavailableModelNotice').isVisible(), send: await page.locator('#sendBtn').isDisabled(), queue: await page.locator('#queueMessageBtn').isDisabled(), redirect: await page.locator('#redirectMessageBtn').isDisabled(), requests: await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length), draft: await page.locator('#messageInput').inputValue() }, { notice: true, send: true, queue: true, redirect: true, requests: 0, draft: 'Preserve this draft after sign-out' });
	assert.match(await page.locator('#modelChip').innerText(), /catalog:openai:credential-model/);
	await page.locator('#modelChip').click();
	assert.equal(await page.locator('[data-discovered][data-model="catalog:openai:credential-model"]').count(), 0);
	await page.locator('#modelChip').click();
	await post(page, { type: 'providerCatalog', snapshot: snapshot([model], { credentialSource: 'broker' }), metadata });
	assert.deepEqual({ notice: await page.locator('#unavailableModelNotice').isVisible(), send: await page.locator('#sendBtn').isDisabled() }, { notice: false, send: false });
	assert.match(await page.locator('#modelChip').innerText(), /Credential-backed model/);
});

test('configured inventories retire removed deployments and Z.AI models without treating invalid settings as an empty inventory', async t => {
	const page = await openSurface(t, 'chat', 400);
	for (const provider of ['foundry', 'bedrock', 'zai']) {
		const model = { id: `catalog:${provider}:deployment`, model: 'deployment', label: `${provider} deployment`, chat: true };
		const snapshot = (models, state = {}) => ({ updatedAt: Date.now(), software: [], providers: [{ id: provider, name: provider, credentialSource: 'none', catalogStatus: provider === 'zai' ? 'catalog-unavailable' : 'configuration-only', configurationComplete: true, inferenceStatus: 'not-verified', models, ...state }] });
		await post(page, { type: 'providerCatalog', snapshot: snapshot([model]) });
		await post(page, { type: 'loadConversation', conversationId: provider, lastModel: model.id, messages: [] });
		assert.equal(await page.locator('#unavailableModelNotice').isVisible(), false);
		for (const state of [{ catalogStatus: 'error', configurationComplete: false }, { catalogStatus: 'error', configurationComplete: true }, { catalogStatus: 'disabled' }, { catalogStatus: provider === 'zai' ? 'configuration-only' : 'catalog-unavailable' }, { configurationComplete: false }, { truncated: true }]) {
			await post(page, { type: 'providerCatalog', snapshot: snapshot([], state) });
			assert.equal(await page.locator('#sendBtn').isDisabled(), false);
		}
		await post(page, { type: 'providerCatalog', snapshot: snapshot([]) });
		assert.equal(await page.locator('#unavailableModelNotice').isVisible(), true);
		await post(page, { type: 'providerCatalog', snapshot: snapshot([], { catalogStatus: provider === 'zai' ? 'catalog-unavailable' : 'not-configured' }) });
		await page.locator('#messageInput').fill('Keep the selected deployment'); await page.locator('#messageInput').press('Enter');
		assert.deepEqual({ send: await page.locator('#sendBtn').isDisabled(), queue: await page.locator('#queueMessageBtn').isDisabled(), redirect: await page.locator('#redirectMessageBtn').isDisabled(), requests: await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length) }, { send: true, queue: true, redirect: true, requests: 0 });
		assert.match(await page.locator('#modelChip').innerText(), new RegExp(`catalog:${provider}:deployment`));
		await post(page, { type: 'providerCatalog', snapshot: snapshot([model]) });
		assert.equal(await page.locator('#sendBtn').isDisabled(), false);
	}
});

test('queued draft acknowledgements correlate request ids without erasing a newer composer draft', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.locator('#messageInput').fill('Start the current task'); await page.locator('#sendBtn').click();
	await post(page, { type: 'streamToken', token: 'I am reviewing the implementation.' });
	await page.locator('#messageInput').fill('First follow-up'); await page.locator('#queueMessageBtn').click();
	await page.locator('#messageInput').fill('Second follow-up'); await page.locator('#queueMessageBtn').click();
	const queued = await page.evaluate(() => sentMessages.filter(message => message.type === 'queueMessage'));
	assert.equal(queued.length, 2); assert.notEqual(queued[0].id, queued[1].id);
	await post(page, { type: 'queueAccepted', conversationId: 'initial-conversation', id: queued[0].id });
	assert.equal(await page.locator('#messageInput').inputValue(), 'Second follow-up');
	await post(page, { type: 'queueAccepted', conversationId: 'initial-conversation', id: queued[1].id });
	assert.equal(await page.locator('#messageInput').inputValue(), '');
	await post(page, { type: 'followupQueue', conversationId: 'initial-conversation', paused: false, entries: [{ id: 'first', label: 'First follow-up' }, { id: 'second', label: 'Second follow-up' }] });
	await page.locator('#messageInput').fill('Keep this unsent draft');
	await post(page, { type: 'queueAccepted', conversationId: 'initial-conversation', id: queued[1].id });
	assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this unsent draft');
	await assertNoPageOverflow(page); await screenshot(page, 'followup-queue-sidebar');
	await post(page, { type: 'requestSettled', cancelled: false });
	await post(page, { type: 'dispatchQueuedDraft', conversationId: 'initial-conversation', draft: queued[0] });
	assert.equal(await page.locator('#messageInput').inputValue(), 'Keep this unsent draft');
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length), 1, 'Host-dispatched drafts only render in the webview');
	assert.equal(await page.locator('.msg-user').last().innerText(), 'First follow-up');
});

test('context source exclusions are scoped to the draft and stale preview responses cannot replace current sources', async t => {
	const page = await openSurface(t, 'chat', 400);
	await page.locator('#workspaceContextDetails summary').click();
	await page.waitForFunction(() => sentMessages.some(message => message.type === 'previewWorkspaceContext'));
	const request = await page.evaluate(() => sentMessages.filter(message => message.type === 'previewWorkspaceContext').at(-1));
	const sections = [
		{ id: 'active-file', label: 'Active File', estimatedTokens: 42, excluded: false, markdown: 'src/editor.ts\nconst answer = 42;' },
		{ id: 'diagnostics', label: 'Problems', estimatedTokens: 10, excluded: false, markdown: 'No current diagnostics.' },
	];
	await post(page, { type: 'workspaceContextPreview', conversationId: 'initial-conversation', requestId: request.id, id: 'snapshot-1', sections, markdown: 'Current context', estimatedTokens: 52 });
	await page.getByRole('checkbox', { name: 'Include Active File', exact: true }).click();
	const excluded = await page.evaluate(() => sentMessages.filter(message => message.type === 'previewWorkspaceContext').at(-1));
	assert.deepEqual(excluded.excludedContext, ['active-file']);
	await post(page, { type: 'workspaceContextPreview', conversationId: 'initial-conversation', requestId: request.id, id: 'stale', markdown: 'STALE PREVIEW' });
	assert.doesNotMatch(await page.locator('#workspaceContextPreview').innerText(), /STALE/);
	await post(page, { type: 'workspaceContextPreview', conversationId: 'initial-conversation', requestId: excluded.id, id: 'snapshot-2', sections: sections.map(section => ({ ...section, excluded: section.id === 'active-file' })), markdown: 'No current diagnostics.', estimatedTokens: 10 });
	await page.locator('#workspaceContextPreview details').first().locator('summary').focus(); await page.keyboard.press('Enter');
	await page.locator('#messageInput').fill('Review without the active file');
	await assertNoPageOverflow(page); await screenshot(page, 'context-sources-sidebar');
	await page.locator('#sendBtn').click();
	const sent = await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').at(-1));
	assert.deepEqual(sent.excludedContext, ['active-file']); assert.equal(sent.contextSnapshotId, 'snapshot-2');
	await post(page, { type: 'loadConversation', conversationId: 'different-context', messages: [] });
	await page.locator('#messageInput').fill('Fresh workspace context'); await page.locator('#sendBtn').click();
	assert.deepEqual(await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').at(-1).excludedContext), []);
});

test('assistant-first history windows restore off-window prompts across system messages and incomplete turns', async t => {
	const page = await openSurface(t, 'chat', 420);
	const messages = Array.from({ length: 601 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Message ${index}` }));
	for (const boundary of [201, 301, 401]) {
		messages[boundary - 5] = { role: 'user', content: `Abandoned request ${boundary}` };
		messages[boundary - 4] = { role: 'user', content: `Visible request ${boundary}`, model: 'haiku', specialistId: 'anton-code', request: { text: `Original prompt ${boundary}`, attachments: ['terminal-output'], includeWorkspaceContext: false, chatMode: 'plan' } };
		for (let index = boundary - 3; index < boundary; index++) { messages[index] = { role: 'system', content: `Status before ${boundary}` }; }
		messages[boundary] = { role: 'assistant', content: `Response at boundary ${boundary}` };
	}
	messages[600] = { role: 'user', content: 'Unanswered latest request' };
	await post(page, { type: 'loadConversation', conversationId: 'assistant-boundaries', messages }); await frames(page);
	const response = index => page.locator(`.msg[data-conversation-index="${index}"]`);
	for (const boundary of [401, 301, 201]) {
		assert.equal(await page.locator('.msg').first().getAttribute('data-conversation-index'), String(boundary));
		assert.equal(await response(boundary - 4).count(), 0, 'The preceding prompt must still be outside the mounted window');
		const reuse = response(boundary).getByRole('button', { name: 'Reuse Prompt', exact: true });
		assert.equal(await reuse.isVisible(), true, 'Assistant-first pages must expose their off-window prompt immediately');
		await reuse.click();
		assert.equal(await page.locator('#messageInput').inputValue(), `Original prompt ${boundary}`);
		assert.match(await page.locator('#contextChips').innerText(), /Terminal output/);
		assert.equal(await page.locator('#includeWorkspaceContext').isChecked(), false);
		assert.equal(await page.locator('#planActBtnPlan').getAttribute('aria-checked'), 'true');
		assert.ok(await page.locator('.msg').count() <= 300);
		if (boundary !== 201) {
			await response(boundary).evaluate(node => { window.boundaryResponse = node; });
			await page.getByRole('button', { name: /Show Earlier Messages/ }).click(); await frames(page);
			assert.equal(await response(boundary).evaluate(node => node === window.boundaryResponse), true, 'An overlapping assistant keeps its mounted controls');
			assert.equal(await response(boundary - 4).count(), 1);
			await response(boundary).getByRole('button', { name: 'Reuse Prompt', exact: true }).click();
			assert.equal(await page.locator('#messageInput').inputValue(), `Original prompt ${boundary}`, 'Mounting the preceding user must not change an existing response action');
		}
	}
	assert.equal(await page.evaluate(() => sentMessages.filter(message => message.type === 'sendMessage').length), 0);
});

test('an assistant without any preceding user cannot reuse a later incomplete request', async t => {
	const page = await openSurface(t, 'chat', 420);
	const messages = Array.from({ length: 220 }, (_, index) => ({ role: index < 20 ? 'system' : 'assistant', content: `Message ${index}` }));
	messages[219] = { role: 'user', content: 'Later incomplete request' };
	await post(page, { type: 'loadConversation', conversationId: 'orphan-assistant', messages }); await frames(page);
	const orphan = page.locator('.msg[data-conversation-index="20"]');
	assert.equal(await orphan.getByRole('button', { name: 'Reuse Prompt', exact: true }).count(), 0);
	await page.getByRole('button', { name: /Show Earlier Messages/ }).click(); await frames(page);
	assert.equal(await orphan.getByRole('button', { name: 'Reuse Prompt', exact: true }).count(), 0);
	assert.equal(await page.locator('#messageInput').inputValue(), '');
});

test('response actions wait for persisted identities and ignore visual offsets and stale terminal events', async t => {
	const page = await openSurface(t, 'chat', 400);
	const conversationId = 'action-identities';
	await post(page, { type: 'loadConversation', conversationId, messages: [] });
	async function send(text, turnId) {
		await page.locator('#messageInput').fill(text); await page.locator('#sendBtn').click();
		const request = await page.evaluate(() => sentMessages.findLast(message => message.type === 'sendMessage'));
		const identity = { conversationId, requestId: request.requestId, turnId };
		await post(page, { type: 'turnAccepted', ...identity });
		return identity;
	}
	const rejected = await send('/help', 'local-command');
	await post(page, { type: 'systemMessage', conversationId, persistedIndex: 0, content: 'Local command help' });
	await post(page, { type: 'requestSettled', ...rejected, cancelled: false });
	const provisional = page.locator('.msg-assistant').first();
	assert.equal(await provisional.getByRole('button', { name: 'Branch Here', exact: true }).count(), 0);
	assert.equal(await provisional.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).count(), 0);
	assert.equal(await provisional.getByRole('button', { name: 'Reuse Prompt', exact: true }).count(), 1);
	const first = await send('First saved question', 'first-saved');
	await post(page, { type: 'checkpointCaptured', ...first, checkpointId: 'first-checkpoint', turnIndex: 1, capturedAt: Date.now() });
	await post(page, { type: 'messagePersisted', ...first, role: 'user', messageIndex: 1 });
	const user = page.locator('.msg-user[data-persisted-index="1"]');
	assert.equal(await user.getAttribute('data-conversation-index'), '3');
	assert.equal(await user.evaluate(node => node.nextElementSibling?.dataset.checkpointId), 'first-checkpoint');
	await post(page, { type: 'streamToken', ...first, token: '**First saved answer**' });
	await post(page, { type: 'systemMessage', conversationId, persistedIndex: 2, content: 'Settings changed while streaming' });
	await post(page, { type: 'messageComplete', ...first });
	const firstResponse = page.locator('.msg-assistant[data-request-id="' + first.requestId + '"]');
	assert.equal(await firstResponse.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).count(), 0);
	await firstResponse.getByRole('button', { name: 'Copy Message', exact: true }).click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).text), '**First saved answer**');
	const second = await send('Second saved question', 'second-saved');
	await post(page, { type: 'messagePersisted', ...second, role: 'user', messageIndex: 4 });
	await post(page, { type: 'messagePersisted', ...first, role: 'assistant', messageIndex: 3, responseId: 'first-response-reference' });
	await post(page, { type: 'messageMetrics', ...first, model: 'haiku', inputTokens: 17, outputTokens: 8 });
	await post(page, { type: 'streamError', ...first, error: 'Late stale error' });
	await post(page, { type: 'requestSettled', ...first });
	assert.equal(await page.locator('#sendBtn').getAttribute('aria-label'), 'Stop generating');
	assert.equal(await page.locator('.msg').filter({ hasText: 'Late stale error' }).count(), 0);
	assert.equal(await firstResponse.getAttribute('data-input-tokens'), '17');
	assert.equal(await firstResponse.getAttribute('data-persisted-index'), '3');
	await post(page, { type: 'streamToken', ...second, token: 'Second saved answer' });
	await post(page, { type: 'messageComplete', ...second });
	await post(page, { type: 'messagePersisted', ...second, role: 'assistant', messageIndex: 5, responseId: 'second-response-reference' });
	await post(page, { type: 'requestSettled', ...second });
	await firstResponse.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'feedback', conversationId, messageIndex: 3, responseId: 'first-response-reference', value: 'up' });
	await firstResponse.getByRole('button', { name: 'Branch Here', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'branchResponse', conversationId, messageIndex: 3, responseId: 'first-response-reference' });
	await firstResponse.getByRole('button', { name: 'Reuse Prompt', exact: true }).click();
	assert.equal(await page.locator('#messageInput').inputValue(), 'First saved question');
	assert.equal(await provisional.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).count(), 0);
	await firstResponse.evaluate(node => { window.staleBranch = node.querySelector('.msg-action-branch'); });
	await post(page, { type: 'loadConversation', conversationId: 'different', messages: [] });
	const before = await page.evaluate(() => sentMessages.length);
	await page.evaluate(() => window.staleBranch.click());
	await post(page, { type: 'messagePersisted', ...first, role: 'assistant', messageIndex: 0, responseId: 'stale' });
	assert.equal(await page.evaluate(() => sentMessages.length), before);
	assert.equal(await page.locator('.msg').count(), 0);
});

test('queued retries retain distinct response identities across bounded timeline eviction', async t => {
	const page = await openSurface(t, 'chat', 400);
	const conversationId = 'retry-history';
	await post(page, { type: 'loadConversation', conversationId, messages: Array.from({ length: 600 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `Saved ${index}`, responseId: index % 2 ? `history-${index}` : undefined })) });
	async function dispatch(requestId, turnId) {
		const identity = { conversationId, requestId, turnId };
		await post(page, { type: 'dispatchQueuedDraft', conversationId, draft: { text: 'Retry this question', requestId, includeWorkspaceContext: false } });
		await post(page, { type: 'turnAccepted', ...identity });
		return identity;
	}
	const failed = await dispatch('queue-failed-attempt', 'failed-turn');
	await post(page, { type: 'streamError', ...failed, error: 'Context unavailable' });
	await post(page, { type: 'requestSettled', ...failed });
	const retry = await dispatch('queue-successful-attempt', 'retry-turn');
	await post(page, { type: 'messagePersisted', ...retry, role: 'user', messageIndex: 600 });
	await post(page, { type: 'streamToken', ...retry, token: '## Saved retry answer' });
	for (let i = 0; i < 4; i++) { await page.getByRole('button', { name: /Show Earlier Messages/ }).click(); await frames(page); }
	await post(page, { type: 'messageComplete', ...retry }); await frames(page);
	assert.equal(await page.locator('.msg-assistant[data-request-id="queue-successful-attempt"]').count(), 0);
	await post(page, { type: 'messagePersisted', ...retry, role: 'assistant', messageIndex: 601, responseId: 'saved-retry-reference' });
	await post(page, { type: 'requestSettled', ...retry });
	await page.getByRole('button', { name: 'Jump to Latest Messages', exact: true }).click(); await frames(page);
	const response = page.locator('.msg-assistant[data-request-id="queue-successful-attempt"]');
	const rejected = page.locator('.msg-assistant[data-request-id="queue-failed-attempt"]');
	assert.equal(await response.getAttribute('data-conversation-index'), '603');
	assert.equal(await response.getAttribute('data-persisted-index'), '601');
	assert.equal(await rejected.getAttribute('data-conversation-index'), '601');
	assert.equal(await rejected.getAttribute('data-persisted-index'), null);
	assert.equal(await rejected.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).count(), 0);
	assert.equal(await rejected.getByRole('button', { name: 'Reuse Prompt', exact: true }).count(), 1);
	await response.getByRole('button', { name: 'Mark Response as Helpful', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'feedback', conversationId, messageIndex: 601, responseId: 'saved-retry-reference', value: 'up' });
	await response.getByRole('button', { name: 'Copy Message', exact: true }).click();
	assert.equal(await page.evaluate(() => sentMessages.at(-1).text), '## Saved retry answer');
	assert.ok(await page.locator('.msg').count() <= 300);
	await assertNoPageOverflow(page);
});

test('active turn reload rebinds saved rows and stale host acceptance cannot replace a newer send', async t => {
	const page = await openSurface(t, 'chat', 400);
	const identity = { conversationId: 'reloaded-turn', requestId: 'original-request', turnId: 'original-turn' };
	const user = { role: 'user', content: 'Reload question', timestamp: 1 };
	await post(page, { type: 'loadConversation', conversationId: identity.conversationId, messages: [user] });
	await post(page, { type: 'turnResumed', ...identity, userMessageIndex: 0, partialText: 'Before reload. ', draft: { text: user.content } });
	await post(page, { type: 'streamToken', ...identity, token: 'After reload.' });
	await post(page, { type: 'messageComplete', ...identity });
	await post(page, { type: 'messagePersisted', ...identity, role: 'assistant', messageIndex: 1, responseId: 'resumed-reference' });
	await post(page, { type: 'requestSettled', ...identity });
	assert.equal(await page.locator('.msg-user').count(), 1);
	assert.equal(await page.locator('.msg-assistant').count(), 1);
	assert.match(await page.locator('.msg-assistant').innerText(), /Before reload\. After reload\./);
	await page.getByRole('button', { name: 'Branch Here', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'branchResponse', conversationId: identity.conversationId, messageIndex: 1, responseId: 'resumed-reference' });
	const saved = { role: 'assistant', content: 'Already saved at reload', timestamp: 2, responseId: 'loaded-reference' };
	await post(page, { type: 'loadConversation', conversationId: identity.conversationId, messages: [user, saved] });
	await post(page, { type: 'turnResumed', ...identity, userMessageIndex: 0, assistantMessageIndex: 1, partialText: saved.content });
	assert.equal(await page.getByRole('button', { name: 'Branch Here', exact: true }).isDisabled(), true, 'branch must wait for host settlement even when the response was saved');
	await post(page, { type: 'requestSettled', ...identity });
	assert.equal(await page.getByRole('button', { name: 'Branch Here', exact: true }).isDisabled(), false);
	assert.equal(await page.locator('.msg').count(), 2, 'reload after saving must not duplicate the saved response');
	assert.equal(await page.getByRole('button', { name: 'Branch Here', exact: true }).count(), 1);
	await page.locator('#messageInput').fill('New local request'); await page.locator('#sendBtn').click();
	const local = await page.evaluate(() => sentMessages.findLast(message => message.type === 'sendMessage'));
	await post(page, { type: 'turnAccepted', conversationId: identity.conversationId, requestId: 'old-ui-block-request', turnId: 'old-ui-block-turn', draft: { text: 'Older synthetic question' } });
	const current = { conversationId: identity.conversationId, requestId: local.requestId, turnId: 'new-local-turn' };
	await post(page, { type: 'turnAccepted', ...current });
	await post(page, { type: 'streamToken', ...current, token: 'New local answer' });
	await post(page, { type: 'messageComplete', ...current });
	await post(page, { type: 'messagePersisted', ...current, role: 'assistant', messageIndex: 3, responseId: 'local-reference' });
	assert.equal(await page.locator('.msg').filter({ hasText: 'Older synthetic question' }).count(), 0);
	assert.match(await page.locator('.msg-assistant').last().innerText(), /New local answer/);
	await page.locator('.msg-assistant').last().getByRole('button', { name: 'Mark Response as Helpful', exact: true }).click();
	assert.deepEqual(await page.evaluate(() => sentMessages.at(-1)), { type: 'feedback', conversationId: identity.conversationId, messageIndex: 3, responseId: 'local-reference', value: 'up' });
});
