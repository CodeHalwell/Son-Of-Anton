/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function verifyGraph(extension) {
	const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
	await fs.writeFile(path.join(workspace, 'graph-fixture.ts'), 'export function installedGraphProbe() { return 42; }\n');
	const child = spawn(process.execPath, [path.join(extension.extensionPath, 'runtime/codegraph/index.cjs'), `--index-root=${workspace}`, `--db=${path.join(path.dirname(process.env.SOTA_INSTALL_RESULT), 'graph.db')}`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' });
	let buffer = '', sequence = 0, errors = '';
	const pending = new Map();
	child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
	const fail = error => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
	child.on('error', fail); child.on('close', () => fail(new Error('Packaged graph process exited'))); child.stdin.on('error', fail);
	child.stdout.on('data', chunk => {
		buffer += chunk;
		while (buffer.includes('\n')) {
			const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
			try { const reply = JSON.parse(line), entry = pending.get(reply.id); if (entry) { pending.delete(reply.id); clearTimeout(entry.timer); reply.error ? entry.reject(new Error(reply.error.message)) : entry.resolve(reply.result); } }
			catch (error) { fail(error); }
		}
	});
	const request = (method, params) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Packaged graph request timed out: ${method}`)); }, 10000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
	const call = async (name, args = {}) => { const response = await request('tools/call', { name, arguments: args }); assert.ok(!response.isError, JSON.stringify(response.content)); return JSON.parse(response.content[0].text); };
	try {
		await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'installed-ide-test', version: '1' } });
		child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
		const deadline = Date.now() + 20000; let state;
		while (Date.now() < deadline) { state = await call('codegraph_status'); if (state.state === 'ready' || state.state === 'failed') { break; } await new Promise(resolve => setTimeout(resolve, 100)); }
		assert.equal(state.state, 'ready', errors); const symbols = await call('symbol_lookup', { query: 'installedGraphProbe' }); assert.equal(symbols.length, 1);
		return { state: state.state, symbols: symbols.length, runtime: 'packaged-electron' };
	} finally { child.stdin.end(); child.kill(); await new Promise(resolve => { if (child.exitCode !== null) { resolve(); return; } const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000); child.once('close', () => { clearTimeout(timer); resolve(); }); }); }
}
exports.run = async () => {
	const started = Date.now(), extension = vscode.extensions.getExtension('son-of-anton.son-of-anton');
	assert.ok(extension, `Built-in Son of Anton extension is unavailable (trusted=${vscode.workspace.isTrusted}; loaded=${vscode.extensions.all.map(item => item.id).join(', ')})`);
	await extension.activate(); assert.equal(extension.isActive, true);
	const commands = await vscode.commands.getCommands(true);
	const required = ['sota.openChat', 'sota.openTaskBoard', 'sota.openSetupWizard', 'sota.reviewWithCouncil', 'sota.diagnoseAcpAgents'];
	for (const command of required) { assert.ok(commands.includes(command), `Missing command ${command}`); }
	// Read-only first-run surfaces must open without credentials or granting agent execution trust.
	for (const command of ['sota.openChat', 'sota.openSetupWizard', 'sota.reviewWithCouncil']) { await vscode.commands.executeCommand(command); }
	const native = require(path.join(extension.extensionPath, 'runtime/codegraph/node_modules/@son-of-anton/codegraph-napi/engine.node'));
	assert.equal(typeof native, 'object');
	assert.ok(Object.keys(native).length, 'Native graph exports are missing');
	const graph = await verifyGraph(extension);
	await fs.writeFile(process.env.SOTA_INSTALL_RESULT, JSON.stringify({ success: true, extensionPath: extension.extensionPath, commands: required, graph, graphExports: Object.keys(native), activationMs: Date.now() - started, memory: process.memoryUsage(), trusted: vscode.workspace.isTrusted }, null, 2));
};
