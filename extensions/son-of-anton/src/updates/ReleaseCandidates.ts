/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { l10n } from 'vscode';
import { eligibleReleases, installerForRelease, type IdeRelease, type Installer, type ReleaseChannel } from './ReleaseManifest';

export interface InstalledBuild { commit?: string; date?: string; version: string }
export interface ReleaseCandidate { release: IdeRelease; installer: Installer }
export const MAX_RELEASE_CANDIDATES = 100;

/** Verify identity before advertising an update; source dates alone cannot identify the installed release. */
export async function verifiedReleaseCandidates(releases: IdeRelease[], installed: InstalledBuild, target: string, channel: ReleaseChannel, rollback: boolean, readManifest: (release: IdeRelease) => Promise<string>): Promise<ReleaseCandidate[]> {
	const installedAt = installed.date ? Date.parse(installed.date) : NaN;
	const installedCommit = /^[a-f\d]{40}$/i.test(installed.commit ?? '') ? installed.commit!.toLowerCase() : undefined;
	const candidates = eligibleReleases(releases.slice(0, MAX_RELEASE_CANDIDATES), channel).filter(release => rollback
		? Number.isFinite(installedAt) && Date.parse(release.published_at) < installedAt
		: Number.isFinite(installedAt) ? Date.parse(release.published_at) > installedAt : release.tag_name.localeCompare(`ide-v${installed.version}`, undefined, { numeric: true }) > 0);
	const verified: ReleaseCandidate[] = [];
	let readable = 0, firstFailure: unknown;
	// One bounded batch at a time preserves release order and limits metadata request concurrency.
	for (let offset = 0; offset < candidates.length; offset += 4) {
		const batch = await Promise.all(candidates.slice(offset, offset + 4).map(async release => {
			if (!release.assets.some(asset => asset.name === 'build-manifest.json')) { return undefined; }
			try {
				const installer = installerForRelease(release, await readManifest(release), target, channel);
				readable++;
				if (installedCommit ? installer.commit.toLowerCase() === installedCommit : release.tag_name === `ide-v${installed.version}`) { return undefined; }
				return { release, installer };
			} catch (error) { firstFailure ??= error; return undefined; }
		}));
		verified.push(...batch.filter((candidate): candidate is ReleaseCandidate => candidate !== undefined));
	}
	if (!readable && firstFailure !== undefined) { throw new Error(l10n.t('No published IDE release could be verified: {0}', firstFailure instanceof Error ? firstFailure.message : String(firstFailure))); }
	return verified;
}
