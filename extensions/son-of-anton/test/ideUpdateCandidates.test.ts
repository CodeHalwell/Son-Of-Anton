/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { arch, tmpdir } from 'node:os';
import type * as vscode from 'vscode';
import { verifiedReleaseCandidates } from '../src/updates/ReleaseCandidates';
import type { IdeRelease } from '../src/updates/ReleaseManifest';

suite('Verified IDE update candidates', () => {
	const commit = 'a'.repeat(40), nextCommit = 'c'.repeat(40), sha256 = 'b'.repeat(64);
	const installed = { commit, version: '1.2.3', date: '2026-01-01T00:00:00Z' };
	function fixture(version: string, sourceCommit = commit, published = '2026-01-02T00:00:00Z', target = 'darwin-arm64') {
		const suffix = target.startsWith('darwin') ? '.dmg' : target.startsWith('win32') ? '-setup.exe' : '.deb';
		const name = `son-of-anton-${version}-${target}${suffix}`, tag = `ide-v${version}`;
		const url = (asset: string) => `https://github.com/CodeHalwell/Son-Of-Anton/releases/download/${tag}/${asset}`;
		const release: IdeRelease = { tag_name: tag, name: tag, draft: false, prerelease: false, published_at: published, html_url: '', assets: [{ name, browser_download_url: url(name), size: 123, digest: `sha256:${sha256}` }, { name: 'build-manifest.json', browser_download_url: url('build-manifest.json'), size: 1 }] };
		const manifest = JSON.stringify({ version: 1, channel: 'stable', ideVersion: version, commit: sourceCommit, builds: [{ target, signing: target.startsWith('darwin') ? 'developer-id-notarized' : target.startsWith('win32') ? 'authenticode' : 'unsigned', files: [{ name, bytes: 123, sha256 }] }] });
		return { release, manifest };
	}
	test('a current release published after its source commit is excluded before notification or selection', async () => {
		const current = fixture('1.2.3'), next = fixture('1.2.4', nextCommit), renamed = fixture('1.2.5', commit.toUpperCase());
		const fixtures = [current, next, renamed];
		const candidates = await verifiedReleaseCandidates(fixtures.map(entry => entry.release), installed, 'darwin-arm64', 'stable', false, async release => fixtures.find(entry => entry.release === release)!.manifest);
		assert.deepEqual(candidates.map(entry => [entry.release.tag_name, entry.installer.commit]), [['ide-v1.2.4', nextCommit]]);
		assert.deepEqual(await verifiedReleaseCandidates([current.release], installed, 'darwin-arm64', 'stable', false, async () => current.manifest), []);
	});
	test('verified version excludes the current build when installed commit metadata is absent', async () => {
		const current = fixture('1.2.3');
		assert.deepEqual(await verifiedReleaseCandidates([current.release], { ...installed, commit: undefined }, 'darwin-arm64', 'stable', false, async () => current.manifest), []);
		const mismatched = current.manifest.replace('"ideVersion":"1.2.3"', '"ideVersion":"1.2.4"');
		await assert.rejects(verifiedReleaseCandidates([current.release], installed, 'darwin-arm64', 'stable', false, async () => mismatched), /Invalid IDE build manifest/);
	});
	test('rollback keeps verified older builds and never offers the installed commit', async () => {
		const older = fixture('1.2.2', nextCommit, '2025-12-30T00:00:00Z'), same = fixture('1.2.1', commit, '2025-12-29T00:00:00Z'), newer = fixture('1.2.4', nextCommit);
		const fixtures = [older, same, newer], fetched: string[] = [];
		const candidates = await verifiedReleaseCandidates(fixtures.map(entry => entry.release), installed, 'darwin-arm64', 'stable', true, async release => { fetched.push(release.tag_name); return fixtures.find(entry => entry.release === release)!.manifest; });
		assert.deepEqual(candidates.map(entry => entry.release.tag_name), ['ide-v1.2.2']);
		assert.deepEqual(fetched, ['ide-v1.2.2', 'ide-v1.2.1']);
	});
	test('a malformed manifest does not hide valid updates, while total verification failure is reported', async () => {
		const bad = fixture('1.2.5', nextCommit), good = fixture('1.2.4', nextCommit);
		const read = async (release: IdeRelease) => release === bad.release ? '{"invalid":true}' : good.manifest;
		const candidates = await verifiedReleaseCandidates([bad.release, good.release], installed, 'darwin-arm64', 'stable', false, read);
		assert.deepEqual(candidates.map(entry => entry.release.tag_name), ['ide-v1.2.4']);
		await assert.rejects(verifiedReleaseCandidates([bad.release], installed, 'darwin-arm64', 'stable', false, read), /No published IDE release could be verified/);
	});
	test('candidate verification caps metadata requests at 100 with four requests in flight', async () => {
		const fixtures = Array.from({ length: 105 }, (_, index) => fixture(`1.3.${index}`, nextCommit));
		let active = 0, peak = 0, calls = 0;
		const candidates = await verifiedReleaseCandidates(fixtures.map(entry => entry.release), installed, 'darwin-arm64', 'stable', false, async release => {
			calls++; peak = Math.max(peak, ++active); await new Promise<void>(resolve => setImmediate(resolve)); active--;
			return fixtures.find(entry => entry.release === release)!.manifest;
		});
		assert.deepEqual([candidates.length, calls, peak], [100, 100, 4]);
	});
	test('startup waits for verification and announces the genuinely newer build instead of the installed release', async () => {
		const stub = require('vscode') as typeof vscode;
		const original = { env: stub.env, version: stub.version, configuration: stub.workspace.getConfiguration, register: stub.commands.registerCommand, information: stub.window.showInformationMessage, picker: stub.window.showQuickPick, error: stub.window.showErrorMessage, fetch: globalThis.fetch };
		const root = await fs.mkdtemp(path.join(tmpdir(), 'sota-update-candidates-'));
		const subscriptions: vscode.Disposable[] = [], messages: string[] = [], errors: string[] = [], requests: string[] = [];
		let unblock!: () => void, started!: () => void, announced!: () => void;
		const gate = new Promise<void>(resolve => { unblock = resolve; }), verificationStarted = new Promise<void>(resolve => { started = resolve; }), notification = new Promise<void>(resolve => { announced = resolve; });
		try {
			await fs.writeFile(path.join(root, 'product.json'), JSON.stringify(installed));
			Object.assign(stub, { env: { ...stub.env, appRoot: root }, version: installed.version });
			const { registerIdeUpdates } = require('../src/updates/IdeUpdates') as typeof import('../src/updates/IdeUpdates');
			stub.workspace.getConfiguration = (() => ({ get: (key: string, fallback: unknown) => key === 'updates.checkOnStartup' ? true : key === 'updates.channel' ? 'stable' : fallback })) as typeof stub.workspace.getConfiguration;
			stub.commands.registerCommand = () => ({ dispose() {} });
			stub.window.showInformationMessage = (async (message: string) => { messages.push(message); announced(); return undefined; }) as typeof stub.window.showInformationMessage;
			stub.window.showQuickPick = async () => { throw new Error('No picker without explicit review'); };
			stub.window.showErrorMessage = (async (message: string) => { errors.push(message); return undefined; }) as typeof stub.window.showErrorMessage;
			const target = `${process.platform}-${arch()}`, current = fixture('1.2.3', commit, '2026-01-03T00:00:00Z', target), next = fixture('1.2.4', nextCommit, '2026-01-02T00:00:00Z', target);
			const fixtures = [current, next];
			globalThis.fetch = async (input, init) => {
				const url = String(input); requests.push(url); assert.ok(init?.signal, 'Every metadata request has a deadline and disposal signal');
				if (url.startsWith('https://api.github.com/')) { assert.equal(init?.redirect, 'error'); return new Response(JSON.stringify(fixtures.map(entry => entry.release))); }
				const entry = fixtures.find(entry => entry.release.assets[1].browser_download_url === url); assert.ok(entry, 'Only official manifest URLs may be fetched');
				started(); await gate; return new Response(entry.manifest);
			};
			registerIdeUpdates({ subscriptions, globalStorageUri: { fsPath: root } } as vscode.ExtensionContext);
			await verificationStarted; assert.deepEqual(messages, [], 'Startup must not announce unverified candidates');
			unblock(); await notification;
			assert.deepEqual(messages, ['Son of Anton ide-v1.2.4 is available.']);
			assert.deepEqual(errors, []); assert.equal(requests.length, 3);
		} finally {
			unblock(); for (const subscription of subscriptions) { subscription.dispose(); }
			Object.assign(stub, { env: original.env, version: original.version });
			stub.workspace.getConfiguration = original.configuration; stub.commands.registerCommand = original.register;
			stub.window.showInformationMessage = original.information; stub.window.showQuickPick = original.picker; stub.window.showErrorMessage = original.error; globalThis.fetch = original.fetch;
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
