/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { eligibleReleases, installerForRelease, isPreviewRelease, releaseAssetUrl, type IdeRelease } from '../src/updates/ReleaseManifest';
import { readProfiles, integrationConflicts, captureIntegrationRoutes } from '../src/integrations/IntegrationProfiles';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { diagnosticOverall } from '../src/diagnostics/ServiceDiagnostics';

suite('IDE releases and integration profiles', () => {
	const commit = 'a'.repeat(40), sha256 = 'b'.repeat(64), name = 'son-of-anton-1.2.3-darwin-arm64.dmg';
	const url = `https://github.com/CodeHalwell/Son-Of-Anton/releases/download/ide-v1.2.3/${name}`;
	const release: IdeRelease = { tag_name: 'ide-v1.2.3', name: 'Test', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', html_url: '', assets: [{ name, browser_download_url: url, size: 123, digest: `sha256:${sha256}` }] };
	const manifest = (signing = 'developer-id-notarized', channel = 'stable') => JSON.stringify({ version: 1, channel, ideVersion: '1.2.3', commit, builds: [{ target: 'darwin-arm64', signing, files: [{ name, bytes: 123, sha256 }] }] });
	test('stable installer requires matching native artifact, manifest and GitHub digest', () => {
		assert.deepEqual(installerForRelease(release, manifest(), 'darwin-arm64', 'stable'), { name, bytes: 123, sha256, url, signing: 'developer-id-notarized', commit });
		for (const signing of ['unsigned', 'ad-hoc', 'developer-id']) { assert.throws(() => installerForRelease(release, manifest(signing), 'darwin-arm64', 'stable'), /signing/); }
		assert.throws(() => installerForRelease(release, manifest(), 'win32-x64', 'stable'), /architecture/);
		assert.throws(() => installerForRelease({ ...release, assets: [{ ...release.assets[0], digest: `sha256:${'c'.repeat(64)}` }] }, manifest(), 'darwin-arm64', 'stable'), /disagree/);
		assert.throws(() => installerForRelease(release, manifest('ad-hoc', 'preview'), 'darwin-arm64', 'stable'), /stable channel/);
	});
	test('preview permits explicitly selected unsigned builds without silently entering stable', () => {
		assert.equal(installerForRelease({ ...release, prerelease: true }, manifest('ad-hoc', 'preview'), 'darwin-arm64', 'preview').signing, 'ad-hoc');
		assert.equal(eligibleReleases([{ ...release, draft: true }, { ...release, prerelease: true }, release], 'stable').length, 1);
	});
	test('stable clients reject every suffixed version despite incorrectly stable upstream metadata', () => {
		for (const suffix of ['dev', 'nightly', 'custom-build.7', 'preview', 'rc.1', 'beta', 'alpha']) {
			const version = `1.2.3-${suffix}`, preview = { ...release, tag_name: `ide-v${version}` };
			const mislabeled = JSON.stringify({ ...JSON.parse(manifest()), ideVersion: version });
			assert.equal(isPreviewRelease(preview), true);
			assert.deepEqual(eligibleReleases([preview], 'stable'), []);
			assert.deepEqual(eligibleReleases([preview], 'preview'), [preview]);
			assert.throws(() => installerForRelease(preview, mislabeled, 'darwin-arm64', 'stable'), /stable channel/);
		}
	});
	test('asset origins, tags and filenames cannot redirect download selection', () => {
		for (const candidate of [url.replace('github.com', 'example.com'), url.replace('CodeHalwell', 'attacker'), `${url}?redirect=x`, url.replace('ide-v1.2.3', 'ide-v0.0.1'), url.replace(name, '../installer.exe')]) { assert.throws(() => releaseAssetUrl(candidate, release.tag_name, name)); }
	});
	test('profile validation drops arbitrary configuration and deduplicates selections', () => {
		const result = readProfiles({ version: 1, activeId: 'one', profiles: [{ id: 'one', name: 'Project', entryIds: ['a', 'a', 3], routes: { 'sota.agents.anton-code.acpAgent': 'claude', 'sota.mcp.trustedServers': 'evil' } }] });
		assert.deepEqual([result.activeId, result.profiles[0].entryIds, result.profiles[0].routes], ['one', ['a'], { 'sota.agents.anton-code.acpAgent': 'claude' }]);
		assert.deepEqual(readProfiles({ version: 5 }), { version: 1, profiles: [] });
	});
	test('profile capture includes every contributed specialist route even when an older profile omitted it', () => {
		const manifest = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
		const keys = Object.keys(manifest.contributes.configuration.properties).filter(key => /^sota\.agents\.[\w-]+\.(model|acpAgent)$/.test(key));
		const values = new Map(keys.map(key => [key, key.endsWith('.model') ? 'fixture-model' : 'fixture-adapter']));
		const captured = captureIntegrationRoutes(key => values.get(key));
		assert.deepEqual(Object.keys(captured).sort(), keys.sort());
		assert.equal(captured['sota.agents.anton-test.acpAgent'], 'fixture-adapter');
		assert.deepEqual(captureIntegrationRoutes(() => ({ invalid: true })), {});
	});
	test('conflicts retain source origins and do not merge capabilities by display name', () => {
		const entries = ['claude', 'codex'].map((source, index) => ({ id: String(index), name: 'Build', kind: 'skill' as const, enabled: true, source: source as 'claude' | 'codex', scope: 'user' as const, path: `/${source}/SKILL.md`, description: '' }));
		assert.deepEqual(integrationConflicts({ entries, servers: new Map(), issues: [] }), [entries]);
	});
	test('unobserved and stale services never make overall health green', () => {
		assert.deepEqual([
			diagnosticOverall([]), diagnosticOverall([{ status: 'healthy', checkedAt: 1 }], 200000), diagnosticOverall([{ status: 'unknown', checkedAt: 200000 }], 200000), diagnosticOverall([{ status: 'healthy', checkedAt: 200000 }], 200000),
		], ['unknown', 'unknown', 'unknown', 'healthy']);
	});
});
