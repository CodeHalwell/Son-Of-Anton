/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['.', 'remote', 'remote/web', 'son-of-anton-core', 'son-of-anton-cli',
	'extensions/son-of-anton', 'extensions/son-of-anton-daemon', 'services/code-graph/mcp-server'];
const testExtensions = new Set(['vscode-api-tests', 'vscode-colorize-tests', 'vscode-colorize-perf-tests', 'vscode-test-resolver']);
for (const entry of readdirSync(path.join(root, 'extensions'), { withFileTypes: true })) {
	if (!entry.isDirectory() || testExtensions.has(entry.name)) { continue; }
	for (const directory of [`extensions/${entry.name}`, `extensions/${entry.name}/server`]) {
		if (existsSync(path.join(root, directory, 'package-lock.json')) && !directories.includes(directory)) { directories.push(directory); }
	}
}

function audit(directory, production) {
	const args = ['audit', '--json', ...(production ? ['--omit=dev'] : [])];
	// Windows npm is a cmd shim. The command and every argument are fixed here.
	const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
		cwd: path.join(root, directory), encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024,
		shell: process.platform === 'win32', env: { ...process.env, npm_config_audit: 'true' },
	});
	assert.ok(!result.error && (result.status === 0 || result.status === 1), `Dependency audit did not complete: ${directory}`);
	let report;
	try { report = JSON.parse(result.stdout); } catch { throw new Error(`Invalid dependency audit response: ${directory}`); }
	assert.ok(!report.error && report.metadata?.vulnerabilities && report.vulnerabilities, `Incomplete dependency audit: ${directory}`);
	return report;
}

for (const directory of directories) {
	const report = audit(directory, true);
	assert.equal(report.metadata.vulnerabilities.total, 0, `Shipped dependency advisories in ${directory}: ${Object.keys(report.vulnerabilities).join(', ')}`);
	console.log(`Production dependency audit passed: ${directory}`);
}
// Electron is declared as a development dependency, but its executable ships.
const complete = audit('.', false);
assert.ok(!complete.vulnerabilities.electron, 'The shipped Electron runtime has a dependency advisory');
console.log('Shipped Electron dependency audit passed.');
