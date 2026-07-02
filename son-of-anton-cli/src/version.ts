/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Single source of truth for the `sota` CLI version and the semver helpers
 * that surround it.
 *
 * The version lives in `package.json`. We read it via `require` (rather than a
 * typed `import`) for two reasons:
 *
 *   1. esbuild inlines the JSON at bundle time, so the version is baked into
 *      the SEA single-binary — there is no `package.json` sitting beside the
 *      executable to read at runtime. This mirrors the pattern `seaEntry.ts`
 *      already relies on for its vendor-cache path.
 *   2. For the `node dist/cli.js` dev build, `dist/version.js` resolves
 *      `../package.json` to the real package root, so both flavours agree.
 *
 * Every surface that needs the version — `program.version()`, `sota update`'s
 * current-version check, and `seaEntry`'s vendor cache — imports
 * {@link SOTA_VERSION} so the value can never drift between them.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { version?: string };

/**
 * The version this `sota` binary reports. Baked in at build time from
 * `package.json`. Falls back to a sentinel only if the JSON is somehow
 * unreadable (which cannot happen for the esbuild-inlined SEA build).
 */
export const SOTA_VERSION: string = pkg.version && pkg.version.trim() ? pkg.version.trim() : '0.0.0-dev';

interface ParsedSemver {
	readonly release: readonly [number, number, number];
	/** Pre-release identifiers (the part after `-`), or undefined for a release. */
	readonly prerelease: string | undefined;
}

/**
 * Parse a semver-ish string into a comparable shape. Tolerates a leading `v`,
 * missing minor/patch segments (treated as 0), and a pre-release suffix after
 * the first `-`. Build metadata (`+...`) is ignored per the semver spec.
 */
function parseSemver(version: string): ParsedSemver {
	const cleaned = version.trim().replace(/^v/, '').split('+')[0];
	const dashIndex = cleaned.indexOf('-');
	const core = dashIndex === -1 ? cleaned : cleaned.slice(0, dashIndex);
	const prerelease = dashIndex === -1 ? undefined : cleaned.slice(dashIndex + 1) || undefined;
	const nums = core.split('.').map(p => {
		const n = parseInt(p, 10);
		return Number.isFinite(n) ? n : 0;
	});
	return { release: [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0], prerelease };
}

/**
 * Compare two pre-release strings per the semver spec: dot-separated
 * identifiers, numeric identifiers compared numerically, alphanumeric
 * compared lexically, numeric always lower than alphanumeric, and a shorter
 * set of identifiers lower when all preceding identifiers are equal.
 */
function comparePrerelease(a: string, b: string): number {
	const aIds = a.split('.');
	const bIds = b.split('.');
	const len = Math.max(aIds.length, bIds.length);
	for (let i = 0; i < len; i++) {
		const ai = aIds[i];
		const bi = bIds[i];
		if (ai === undefined) {
			return -1;
		}
		if (bi === undefined) {
			return 1;
		}
		const aNumeric = /^\d+$/.test(ai);
		const bNumeric = /^\d+$/.test(bi);
		if (aNumeric && bNumeric) {
			const diff = parseInt(ai, 10) - parseInt(bi, 10);
			if (diff !== 0) {
				return diff < 0 ? -1 : 1;
			}
		} else if (aNumeric && !bNumeric) {
			return -1;
		} else if (!aNumeric && bNumeric) {
			return 1;
		} else if (ai !== bi) {
			return ai < bi ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Compare two semver strings. Returns -1 when `a < b`, 0 when equal, 1 when
 * `a > b`. Suitable as an `Array.prototype.sort` comparator. Correctly orders
 * e.g. `0.10.0` above `0.9.0` (where a lexicographic sort would not) and ranks
 * a release above its own pre-releases (`1.0.0 > 1.0.0-rc.1`).
 */
export function compareSemver(a: string, b: string): number {
	const pa = parseSemver(a);
	const pb = parseSemver(b);
	for (let i = 0; i < 3; i++) {
		if (pa.release[i] !== pb.release[i]) {
			return pa.release[i] < pb.release[i] ? -1 : 1;
		}
	}
	if (pa.prerelease === pb.prerelease) {
		return 0;
	}
	// A release (no pre-release) has higher precedence than any pre-release.
	if (pa.prerelease === undefined) {
		return 1;
	}
	if (pb.prerelease === undefined) {
		return -1;
	}
	return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * True when `candidate` is a strictly higher semver than `base`. Used by
 * `sota update` to decide whether a newer release exists.
 */
export function isStrictlyGreater(candidate: string, base: string): boolean {
	return compareSemver(candidate, base) > 0;
}

/**
 * Map a release tag to its bare version: `sota-v0.1.0` → `0.1.0`. Tolerates a
 * tag that is already a bare version (returned unchanged).
 */
export function tagToVersion(tag: string): string {
	return tag.replace(/^sota-v/, '');
}
