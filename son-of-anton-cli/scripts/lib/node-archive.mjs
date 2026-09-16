/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// https://nodejs.org/dist/v22.23.2/SHASUMS256.txt — checked 2026-09-14.
export const NODE_ARCHIVE_SHA256 = Object.freeze({
	'node-v22.23.2-darwin-arm64.tar.gz': '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6',
	'node-v22.23.2-darwin-x64.tar.gz': '58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026',
	'node-v22.23.2-linux-arm64.tar.xz': 'fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8',
	'node-v22.23.2-linux-x64.tar.xz': 'd60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307',
	'node-v22.23.2-win-x64.zip': '1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97'
});

export function verifyArchive(filename, expected) {
	if (!/^[a-f0-9]{64}$/.test(expected || '')) { throw new Error('A pinned SHA-256 checksum is required'); }
	if (createHash('sha256').update(readFileSync(filename)).digest('hex') !== expected) {
		throw new Error('Node archive SHA-256 does not match its pinned release');
	}
}
