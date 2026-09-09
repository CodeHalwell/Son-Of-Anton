/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProviderDiscovery, type ProviderDiscoverySnapshot } from './ProviderDiscovery';
import type { MementoStore } from '../host';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }
async function fixture(t: TestContext, request: typeof fetch, state?: MementoStore) {
	const home = await mkdtemp(path.join(tmpdir(), 'sota-discovery-refresh-'));
	const values: Record<string, string> = { xaiBaseUrl: 'https://old.example.test/v1' }; let key = 'old-secret';
	const finder = new ProviderDiscovery({ home, env: { PATH: '' }, state, request,
		secrets: { get: async name => name === 'sota.secrets.xaiApiKey' ? key : undefined, store: async () => {}, delete: async () => {} },
		config: { get: <T>(name: string, fallback?: T) => (values[name] ?? fallback) as T },
	});
	t.after(() => { finder.dispose(); return rm(home, { recursive: true, force: true }); });
	return { finder, values, setKey: (next: string) => { key = next; } };
}
function model(snapshot: ProviderDiscoverySnapshot): string | undefined { return snapshot.providers.find(provider => provider.id === 'xai')?.models[0]?.model; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('forced refresh during an active scan coalesces changes and awaits new credentials and endpoint', async t => {
	const started = deferred(); const release = deferred(); const requests: Array<{ url: string; auth: string | null }> = [];
	const f = await fixture(t, async (input, init) => {
		const request = { url: String(input), auth: new Headers(init?.headers).get('Authorization') }; requests.push(request);
		if (requests.length === 1) { started.resolve(); await release.promise; }
		return Response.json({ data: [{ id: request.auth === 'Bearer old-secret' ? 'old-model' : 'new-model' }] });
	});
	const first = f.finder.refresh(); await started.promise;
	assert.equal(f.finder.refresh(), first);
	f.setKey('new-secret'); f.values.xaiBaseUrl = 'https://new.example.test/v1';
	const forced = f.finder.refresh({ force: true }); let freshSettled = false; void forced.then(() => { freshSettled = true; });
	for (let index = 0; index < 100; index++) { assert.equal(f.finder.refresh({ force: true }), forced); }
	assert.notEqual(forced, first); assert.equal(freshSettled, false);
	release.resolve(); const old = await first; const fresh = await forced;
	await tick(); await f.finder.refresh();
	assert.deepEqual({ old: model(old), fresh: model(fresh), latest: model(f.finder.snapshot()), requests }, { old: 'old-model', fresh: 'new-model', latest: 'new-model', requests: [{ url: 'https://old.example.test/v1/models', auth: 'Bearer old-secret' }, { url: 'https://new.example.test/v1/models', auth: 'Bearer new-secret' }] });
});

test('different discovery options queue a fresh scan even without force and are part of cache validity', async t => {
	const started = deferred(); const release = deferred(); const requests: string[] = [];
	const f = await fixture(t, async input => {
		const url = String(input); requests.push(url);
		if (requests.length === 1) { started.resolve(); await release.promise; }
		return Response.json(url.includes('11434') ? { models: [{ name: 'local-fixture' }] } : { data: [{ id: 'chat-fixture' }] });
	});
	const initial = f.finder.refresh(); await started.promise;
	const local = f.finder.refresh({ includeLocal: true }); assert.notEqual(local, initial);
	release.resolve(); await initial; const enabled = await local; await tick();
	const requestsWithLocal = requests.length; await f.finder.refresh({ includeLocal: true });
	const disabled = await f.finder.refresh({ includeLocal: false });
	assert.deepEqual({ enabled: enabled.providers.find(provider => provider.id === 'ollama')?.catalogStatus, disabled: disabled.providers.find(provider => provider.id === 'ollama')?.catalogStatus, requestsWithLocal, finalRequests: requests.length, localRequests: requests.filter(url => url.startsWith('http://localhost')).length }, { enabled: 'ready', disabled: 'disabled', requestsWithLocal: 4, finalRequests: 5, localRequests: 2 });
});

test('coalesced queued options use the latest choice without accumulating scans', async t => {
	const started = deferred(); const release = deferred(); const urls: string[] = [];
	const f = await fixture(t, async input => { urls.push(String(input)); if (urls.length === 1) { started.resolve(); await release.promise; } return Response.json({ data: [] }); });
	const first = f.finder.refresh(); await started.promise;
	const queued = f.finder.refresh({ force: true, includeLocal: true });
	for (let index = 0; index < 100; index++) { assert.equal(f.finder.refresh({ force: true, includeLocal: index % 2 === 0 }), queued); }
	release.resolve(); await first; const snapshot = await queued; await tick();
	assert.deepEqual({ calls: urls.length, local: snapshot.providers.find(provider => provider.id === 'ollama')?.catalogStatus }, { calls: 2, local: 'disabled' });
});

test('a change received during the follow-up queues one further scan and cannot return its stale result', async t => {
	const started = [deferred(), deferred()]; const release = [deferred(), deferred()]; const keys: Array<string | null> = [];
	const f = await fixture(t, async (_input, init) => {
		const index = keys.length; const key = new Headers(init?.headers).get('Authorization'); keys.push(key);
		if (index < 2) { started[index].resolve(); await release[index].promise; }
		return Response.json({ data: [{ id: key!.replace('Bearer ', '') }] });
	});
	const initial = f.finder.refresh(); await started[0].promise;
	f.setKey('middle'); const second = f.finder.refresh({ force: true }); release[0].resolve(); await initial; await started[1].promise;
	f.setKey('latest'); const third = f.finder.refresh({ force: true });
	for (let index = 0; index < 100; index++) { assert.equal(f.finder.refresh({ force: true }), third); }
	release[1].resolve(); const middle = await second; const latest = await third; await tick();
	assert.deepEqual({ middle: model(middle), latest: model(latest), keys }, { middle: 'middle', latest: 'latest', keys: ['Bearer old-secret', 'Bearer middle', 'Bearer latest'] });
});

test('an explicitly queued refresh runs after a failed scan without an autonomous retry loop', async t => {
	const started = deferred(); const release = deferred(); let calls = 0; let writes = 0;
	const state: MementoStore = { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => { if (++writes === 1) { throw new Error('Storage unavailable'); } } };
	const f = await fixture(t, async () => { if (++calls === 1) { started.resolve(); await release.promise; } return Response.json({ data: [{ id: `model-${calls}` }] }); }, state);
	const first = f.finder.refresh(); const failure = assert.rejects(first, /Storage unavailable/); await started.promise;
	const queued = f.finder.refresh({ force: true }); release.resolve(); await failure;
	assert.equal(model(await queued), 'model-2'); await tick(); await f.finder.refresh(); assert.equal(calls, 2);
});

test('a follow-up failure rejects its waiting callers and does not silently return the first snapshot', async t => {
	const started = deferred(); const release = deferred(); let calls = 0; let writes = 0;
	const state: MementoStore = { get: <T>(_key: string, fallback?: T) => fallback as T, update: async () => { if (++writes === 2) { throw new Error('Fresh snapshot could not be saved'); } } };
	const f = await fixture(t, async () => { if (++calls === 1) { started.resolve(); await release.promise; } return Response.json({ data: [{ id: 'catalog-model' }] }); }, state);
	const initial = f.finder.refresh(); await started.promise; const forced = f.finder.refresh({ force: true }); const failure = assert.rejects(forced, /Fresh snapshot could not be saved/);
	release.resolve(); await initial; await failure; await tick(); assert.deepEqual({ calls, writes }, { calls: 2, writes: 2 });
});

test('disposal immediately rejects active and queued callers, aborts requests, and never starts the follow-up', async t => {
	const started = deferred(); const release = deferred(); let signal: AbortSignal | null | undefined; let calls = 0;
	const f = await fixture(t, async (_input, init) => { calls++; signal = init?.signal; started.resolve(); await release.promise; return Response.json({ data: [{ id: 'too-late' }] }); });
	const initial = f.finder.refresh(); await started.promise; const queued = f.finder.refresh({ force: true });
	f.finder.dispose();
	await Promise.all([assert.rejects(initial, /disposed/), assert.rejects(queued, /disposed/), assert.rejects(f.finder.refresh(), /disposed/)]);
	release.resolve(); await tick(); await tick();
	assert.deepEqual({ aborted: signal?.aborted, calls, updatedAt: f.finder.snapshot().updatedAt }, { aborted: true, calls: 1, updatedAt: 0 });
});
