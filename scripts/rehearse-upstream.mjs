/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { execFileSync, spawnSync } from 'node:child_process';
const ref = process.argv[2];
if (!ref || ref.startsWith('-')) { throw new Error('Pass an existing, reviewed upstream ref: node scripts/rehearse-upstream.mjs <ref>'); }
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const target = git(['rev-parse', '--verify', ref + '^{commit}']);
const base = git(['merge-base', 'HEAD', target]);
console.log(JSON.stringify({ target, base, divergence: git(['rev-list', '--left-right', '--count', 'HEAD...' + target]) }));
// merge-tree writes synthetic Git objects but does not touch HEAD, index, worktree or stashes.
const result = spawnSync('git', ['merge-tree', '--write-tree', 'HEAD', target], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exitCode = result.status ?? 1;
