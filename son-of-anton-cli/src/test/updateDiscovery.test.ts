/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLatestSeaRelease, maybeNagAboutUpdate } from '../commands/update';

const release = (tag_name: string, flags = {}) => ({ tag_name, draft: false, prerelease: false, assets: [], ...flags });

test('CLI update discovery crosses IDE-only pages and chooses the highest stable version', async t => {
	const pages = [Array.from({ length: 100 }, (_, i) => release(`ide-v1.0.${i}`)), [
		release('sota-v0.9.0'), release('sota-v0.10.0'),
		release('sota-v2.0.0', { draft: true }), release('sota-v3.0.0', { prerelease: true }),
		release('sota-v99.0.0-beta'), release('sota-vgarbage'),
	]];
	const calls: string[] = [];
	t.mock.method(globalThis, 'fetch', async (url: string) => {
		calls.push(url); return new Response(JSON.stringify(pages[calls.length - 1]));
	});
	assert.equal((await fetchLatestSeaRelease())?.tag_name, 'sota-v0.10.0');
	assert.deepEqual(calls.map(url => new URL(url).search), ['?per_page=100&page=1', '?per_page=100&page=2']);
});

test('a failed later page does not report an older release as latest', async t => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => ++calls === 1
		? new Response(JSON.stringify([release('sota-v0.1.0'), ...Array.from({ length: 99 }, () => release('ide-v1.0.0'))]))
		: new Response('', { status: 503 }));
	assert.equal(await fetchLatestSeaRelease(), null);
});

test('an incomplete release catalog fails closed after its bounded page limit', async t => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(Array.from({ length: 100 }, () => release('sota-v0.1.0')))); });
	assert.equal(await fetchLatestSeaRelease(), null);
	assert.equal(calls, 10);
});

test('SEA startup checks GitHub releases and does not reuse an npm update cache', async t => {
	const fs: typeof import('node:fs') = require('node:fs');
	const sea: typeof import('node:sea') = require('node:sea');
	t.mock.method(sea, 'isSea', () => true);
	t.mock.method(fs, 'readFileSync', () => JSON.stringify({ checkedAt: Date.now(), latest: '0.0.1', mode: 'npm' }));
	t.mock.method(fs, 'mkdirSync', () => undefined);
	let cached = '', notice = '';
	t.mock.method(fs, 'writeFileSync', (_path: string, content: string) => { cached = content; });
	t.mock.method(process.stderr, 'write', (content: string) => { notice += content; return true; });
	const calls: string[] = [];
	t.mock.method(globalThis, 'fetch', async (url: string) => { calls.push(url); return new Response(JSON.stringify([release('sota-v99.0.0')])); });
	await maybeNagAboutUpdate();
	assert.equal(calls.length, 1);
	assert.equal(new URL(calls[0]).hostname, 'api.github.com');
	assert.equal(JSON.parse(cached).mode, 'sea');
	assert.match(notice, /sota 99\.0\.0 is available/);
});
