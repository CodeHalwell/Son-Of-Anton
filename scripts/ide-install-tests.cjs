/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function verifyWebview() {
	const panel = vscode.window.createWebviewPanel('sota.installProbe', 'Installed webview check', vscode.ViewColumn.One, { enableScripts: true });
	let timer, listener;
	try {
		const ready = new Promise((resolve, reject) => {
			timer = setTimeout(() => reject(new Error('Installed webview did not execute: check the webview service worker and protocol response bounds')), 20000);
			listener = panel.webview.onDidReceiveMessage(message => {
				if (message.type === 'ready') { resolve(); }
			});
		});
		panel.webview.html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'nonce-install-probe\';"></head><body><h1>Installed webview</h1><script nonce="install-probe">acquireVsCodeApi().postMessage({type:"ready"});</script></body></html>';
		await ready;
		return { scriptsExecuted: true };
	} finally { clearTimeout(timer); listener?.dispose(); panel.dispose(); }
}

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
	console.log('[installation-test] Starting bundled extension checks');
	// Exercise both API loaders: Node 24 must link ESM extensions without waiting
	// on a loader thread that needs a response from the blocked extension host.
	const esmProbe = path.join(__dirname, 'esm-vscode-probe.mjs');
	const secondEsmProbe = path.join(__dirname, 'esm-vscode-second-probe.mjs');
	let command;
	try {
		await fs.writeFile(esmProbe, 'export { workspace, commands } from "vscode";\n');
		await fs.writeFile(secondEsmProbe, 'export { workspace, commands } from "vscode";\n');
		const api = await import(require('node:url').pathToFileURL(esmProbe).href);
		const second = await import(require('node:url').pathToFileURL(secondEsmProbe).href);
		assert.equal(api.workspace, second.workspace, 'ESM imports must share their extension API instance');
		assert.deepEqual(api.workspace.workspaceFolders?.map(folder => folder.uri.toString()), vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()));
		command = api.commands.registerCommand('sota.fixture.esmApiProbe', () => 42);
		assert.equal(await vscode.commands.executeCommand('sota.fixture.esmApiProbe'), 42);
	} finally {
		command?.dispose();
		await Promise.all([esmProbe, secondEsmProbe].map(file => fs.rm(file, { force: true })));
	}
	const started = Date.now(), extension = vscode.extensions.getExtension('son-of-anton.son-of-anton');
	assert.ok(extension, `Built-in Son of Anton extension is unavailable (trusted=${vscode.workspace.isTrusted}; loaded=${vscode.extensions.all.map(item => item.id).join(', ')})`);
	console.log('[installation-test] Activating Son of Anton');
	await extension.activate(); assert.equal(extension.isActive, true);
	console.log('[installation-test] Activated Son of Anton');
	const shared = vscode.extensions.getExtension('son-of-anton.son-of-anton-daemon');
	assert.ok(shared, 'Bundled shared runtime client is unavailable');
	await shared.activate(); assert.equal(shared.isActive, true);
	assert.equal(vscode.workspace.getConfiguration('sota').get('runtime.backend'), 'auto', 'Fresh installs must use automatic runtime selection');

	const debuggerExtension = vscode.extensions.getExtension('ms-vscode.js-debug');
	assert.ok(debuggerExtension, 'Bundled JavaScript debugger is unavailable');
	assert.ok(debuggerExtension.packageJSON.contributes.debuggers.some(item => item.type === 'pwa-node'), 'Node.js debug adapter is missing');
	await debuggerExtension.activate();
	assert.equal(debuggerExtension.isActive, true);
	const debuggerInfo = { version: debuggerExtension.packageJSON.version, active: debuggerExtension.isActive, extensionPath: debuggerExtension.extensionPath };
	const commands = await vscode.commands.getCommands(true);
	const required = ['sota.openChat', 'sota.openTaskBoard', 'sota.openSetupWizard', 'sota.reviewWithCouncil', 'sota.diagnoseAcpAgents', 'sota.openSharedSessions', 'sota.daemon.graph', 'sota.daemon.board', 'sota.daemon.knowledge', 'sota.daemon.council'];
	for (const command of required) { assert.ok(commands.includes(command), `Missing command ${command}`); }
	// Read-only first-run surfaces must open without credentials or granting agent execution trust.
	for (const command of ['sota.openChat', 'sota.openSetupWizard', 'sota.reviewWithCouncil']) { console.log(`[installation-test] Opening ${command}`); await vscode.commands.executeCommand(command); }
	const webview = await verifyWebview();
	console.log('[installation-test] Packaged webview executed');
	const native = require(path.join(extension.extensionPath, 'runtime/codegraph/node_modules/@son-of-anton/codegraph-napi/engine.node'));
	assert.equal(typeof native, 'object');
	assert.ok(Object.keys(native).length, 'Native graph exports are missing');
	const graph = await verifyGraph(extension);
	console.log('[installation-test] Packaged graph query passed');
	const files = await vscode.workspace.findFiles('**/graph-fixture.ts', null, 10);
	assert.equal(files.length, 1, 'Installed workspace file search must find the graph fixture');
	await fs.writeFile(process.env.SOTA_INSTALL_RESULT, JSON.stringify({ success: true, extensionPath: extension.extensionPath, debugger: debuggerInfo, sharedRuntime: { extensionPath: shared.extensionPath, backend: process.platform === 'win32' ? 'native' : 'codypendent' }, commands: required, webview, graph, fileSearch: { matches: files.length }, graphExports: Object.keys(native), activationMs: Date.now() - started, memory: process.memoryUsage(), trusted: vscode.workspace.isTrusted }, null, 2));
};
