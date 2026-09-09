/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const IDE_REPOSITORY = 'CodeHalwell/Son-Of-Anton';
export type ReleaseChannel = 'stable' | 'preview';
export interface ReleaseAsset { name: string; browser_download_url: string; size: number; digest?: string }
export interface IdeRelease { tag_name: string; name: string; draft: boolean; prerelease: boolean; published_at: string; html_url: string; assets: ReleaseAsset[] }
export interface Installer { name: string; bytes: number; sha256: string; signing: string; url: string; commit: string }
interface BuildManifest { version: number; channel?: ReleaseChannel; ideVersion: string; commit: string; builds: { target: string; signing: string; files: { name: string; bytes: number; sha256: string }[] }[] }

/** A tag suffix is a preview even when its upstream release metadata is mislabeled. */
export function isPreviewRelease(release: Pick<IdeRelease, 'tag_name' | 'prerelease'>): boolean {
	return release.prerelease || !/^ide-v\d+\.\d+\.\d+$/.test(release.tag_name);
}

/** Reject external origins and tag/path substitution before contacting an asset endpoint. */
export function releaseAssetUrl(value: string, tag: string, name: string): string {
	const url = new URL(value);
	const expected = `/${IDE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
	if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.pathname !== expected || url.username || url.password || url.search || url.hash) { throw new Error('Unexpected installer asset URL.'); }
	return url.href;
}

/** Only native installers with matching manifests, hashes, sizes and release channels are eligible. */
export function installerForRelease(release: IdeRelease, raw: string, target: string, channel: ReleaseChannel): Installer {
	const manifest = JSON.parse(raw) as BuildManifest;
	if (!/^ide-v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.tag_name) || manifest.version !== 1 || !/^[a-f\d]{40}$/i.test(manifest.commit) || !Array.isArray(manifest.builds) || release.tag_name !== `ide-v${manifest.ideVersion}` || release.draft) { throw new Error('Invalid IDE build manifest.'); }
	if (channel === 'stable' && (isPreviewRelease(release) || manifest.channel !== 'stable')) { throw new Error('This release is not eligible for the stable channel.'); }
	const build = manifest.builds.find(entry => entry.target === target);
	if (!build) { throw new Error('This release has no installer for this operating system and architecture.'); }
	if (channel === 'stable' && ((target.startsWith('darwin') && build.signing !== 'developer-id-notarized') || (target.startsWith('win32') && build.signing !== 'authenticode'))) { throw new Error('Stable installer signing requirements were not met.'); }
	const suffix = target.startsWith('darwin') ? '.dmg' : target.startsWith('win32') ? '-setup.exe' : '.deb';
	const name = `son-of-anton-${manifest.ideVersion}-${target}${suffix}`;
	const file = build.files.find(entry => entry.name === name), asset = release.assets.find(entry => entry.name === name);
	if (!file || !asset || !/^[a-f\d]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 4 * 1024 ** 3 || file.bytes !== asset.size) { throw new Error('Installer metadata is missing or inconsistent.'); }
	if (asset.digest && asset.digest !== `sha256:${file.sha256}`) { throw new Error('GitHub and build manifest checksums disagree.'); }
	return { ...file, signing: build.signing, url: releaseAssetUrl(asset.browser_download_url, release.tag_name, name), commit: manifest.commit };
}

/** Preview includes published stable builds; drafts and unrelated CLI releases are excluded. */
export function eligibleReleases(releases: IdeRelease[], channel: ReleaseChannel): IdeRelease[] {
	return releases.filter(release => !release.draft && /^ide-v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(release.tag_name) && (channel === 'preview' || !isPreviewRelease(release)) && Number.isFinite(Date.parse(release.published_at)))
		.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
}
