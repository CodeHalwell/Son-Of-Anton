/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';

/** A version suffix always denotes a preview, regardless of its name or requested channel. */
export function ideReleasePolicy(version, { ref = '', channel = '', requireSigning = false } = {}) {
	assert.match(version, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, 'Invalid IDE release version');
	assert.ok(['', 'stable', 'preview'].includes(channel), 'Invalid release channel');
	const tagged = ref.startsWith('refs/tags/ide-v');
	if (tagged) { assert.equal(ref, `refs/tags/ide-v${version}`, 'Release tag must match package.json version'); }
	const resolved = /^\d+\.\d+\.\d+$/.test(version) ? channel || (tagged ? 'stable' : 'preview') : 'preview';
	return { channel: resolved, requireSigning: requireSigning === true || requireSigning === 'true' || resolved === 'stable' };
}

/** Reject a falsely stable manifest before any release is created. */
export function ideReleasePublicationFlags(version, channel) {
	assert.ok(['stable', 'preview'].includes(channel), 'Invalid release channel');
	const policy = ideReleasePolicy(version, { channel });
	assert.equal(channel, policy.channel, 'A suffixed IDE version cannot be published as stable');
	return policy.channel === 'stable' ? [] : ['--prerelease'];
}
