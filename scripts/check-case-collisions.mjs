/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);
const seen = new Map();
const collisions = new Set();
for (const file of files) {
	const segments = file.split('/');
	for (let length = 1; length <= segments.length; length++) {
		const spelling = segments.slice(0, length).join('/');
		const folded = spelling.normalize('NFC').toLowerCase();
		const previous = seen.get(folded);
		if (previous && previous !== spelling) { collisions.add(`${previous} ↔ ${spelling}`); }
		seen.set(folded, spelling);
	}
}
if (collisions.size) { throw new Error('Case-insensitive checkout collisions:\n' + [...collisions].join('\n')); }
console.log(`Checked ${files.length} tracked paths and their directories: no case collisions.`);
