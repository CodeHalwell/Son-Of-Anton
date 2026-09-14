#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Build every target in isolation and publish only a complete release set. */
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, rmSync } from 'node:fs';
import { withStagedDirectory } from '../../scripts/staged-directory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(__dirname, '..');

const TARGETS = [
	{
		script: 'package-macos-arm64.mjs',
		artefacts: ['sota', 'THIRD_PARTY_LICENSES.txt'],
		artefactRenames: { 'THIRD_PARTY_LICENSES.txt': 'THIRD_PARTY_LICENSES-darwin-arm64.txt' },
	},
	{
		script: 'package-linux-x64.mjs',
		artefacts: ['sota-linux-x64', 'THIRD_PARTY_LICENSES.txt'],
		artefactRenames: { 'THIRD_PARTY_LICENSES.txt': 'THIRD_PARTY_LICENSES-linux-x64.txt' },
	},
	{
		script: 'package-windows-x64.mjs',
		artefacts: ['sota-windows-x64.exe', 'THIRD_PARTY_LICENSES.txt'],
		artefactRenames: { 'THIRD_PARTY_LICENSES.txt': 'THIRD_PARTY_LICENSES-windows-x64.txt' },
	},
];

function run(scriptName, outputDir) {
	const target = resolve(__dirname, scriptName);
	const result = spawnSync(process.execPath, [target], {
		stdio: 'inherit', cwd: CLI_ROOT,
		env: { ...process.env, SOTA_CLI_PACKAGE_OUTPUT: outputDir },
	});
	if (result.status !== 0) {
		throw new Error(`${scriptName} failed; aborting package:all (${result.error?.message ?? result.status})`);
	}
}

export async function packageAll({ outputDir = process.env.SOTA_CLI_PACKAGE_OUTPUT || resolve(CLI_ROOT, 'dist-bundle'), runTarget = run } = {}) {
	await withStagedDirectory(outputDir, async staged => {
		for (const target of TARGETS) {
			const targetOutput = resolve(staged, '.target');
			await runTarget(target.script, targetOutput);
			for (const artefact of target.artefacts) {
				// Missing outputs are failures, never silently accepted partial sets.
				copyFileSync(resolve(targetOutput, artefact), resolve(staged, target.artefactRenames[artefact] ?? artefact));
			}
			rmSync(targetOutput, { recursive: true, force: true });
		}
	});
	process.stdout.write(`All three platform CLI artifacts: ${outputDir}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { await packageAll(); }
