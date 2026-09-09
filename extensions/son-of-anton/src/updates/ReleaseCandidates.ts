/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { l10n } from 'vscode';
import { eligibleReleases, installerForRelease, type IdeRelease, type Installer, type ReleaseChannel } from './ReleaseManifest';

export interface InstalledBuild { commit?: string; date?: string; version: string }
export interface ReleaseCandidate { release: IdeRelease; installer: Installer }
export const MAX_RELEASE_CANDIDATES = 100;

/** SemVer precedence for IDE triplets and prereleases; build metadata does not change ordering. */
function compareVersions(candidate: string, installed: string): number | undefined {
	const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
	const next = parse(candidate), current = parse(installed);
	if (!next || !current) { return undefined; }
	for (let index = 1; index <= 3; index++) {
		const left = BigInt(next[index]), right = BigInt(current[index]);
		if (left !== right) { return left > right ? 1 : -1; }
	}
	if (next[4] === current[4]) { return 0; }
	if (next[4] === undefined) { return 1; }
	if (current[4] === undefined) { return -1; }
	const nextParts = next[4].split('.'), currentParts = current[4].split('.');
	for (let index = 0; index < Math.max(nextParts.length, currentParts.length); index++) {
		const left = nextParts[index], right = currentParts[index];
		if (left === undefined) { return -1; }
		if (right === undefined) { return 1; }
		if (left === right) { continue; }
		const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
		if (leftNumeric && rightNumeric) { const a = BigInt(left), b = BigInt(right); if (a === b) { continue; } return a > b ? 1 : -1; }
		if (leftNumeric !== rightNumeric) { return leftNumeric ? -1 : 1; }
		return left > right ? 1 : -1;
	}
	return 0;
}

/** Versions determine update/rollback direction; publication dates only order the verified choices. */
export async function verifiedReleaseCandidates(releases: IdeRelease[], installed: InstalledBuild, target: string, channel: ReleaseChannel, rollback: boolean, readManifest: (release: IdeRelease) => Promise<string>): Promise<ReleaseCandidate[]> {
	const installedCommit = /^[a-f\d]{40}$/i.test(installed.commit ?? '') ? installed.commit!.toLowerCase() : undefined;
	const candidates = eligibleReleases(releases.slice(0, MAX_RELEASE_CANDIDATES), channel)
		.filter(release => compareVersions(release.tag_name.slice('ide-v'.length), installed.version) === (rollback ? -1 : 1));
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
