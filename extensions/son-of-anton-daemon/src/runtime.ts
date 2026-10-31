/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { credentialEnvironment } from './providerSetup.js';
import { privateRuntimeEnvironment, resolveRuntimeEndpoint, sameRuntimeEndpoint, type RuntimeEndpoint } from './runtimeProfile.js';

export type { RuntimeEndpoint } from './runtimeProfile.js';

let starting: Promise<void> | undefined;
type RuntimeContext = Pick<vscode.ExtensionContext, 'extensionPath' | 'secrets'>;

/** Capture the selected runtime so asynchronous UI actions cannot drift into another product's store. */
export function getRuntimeEndpoint(): RuntimeEndpoint {
	const configuration = vscode.workspace.getConfiguration('sota.daemon');
	return resolveRuntimeEndpoint({ connection: configuration.get<string>('connection'), socketPath: configuration.get<string>('socketPath') });
}

function assertEndpoint(expected: RuntimeEndpoint): void {
	if (!sameRuntimeEndpoint(expected, getRuntimeEndpoint())) { throw new Error(vscode.l10n.t('The agent runtime changed. Retry this action from the current connection.')); }
}

/** Stored Anton credentials are supplied only to Anton-owned child processes. */
export async function getRuntimeEnvironment(context: RuntimeContext): Promise<NodeJS.ProcessEnv> {
	return { ...privateRuntimeEnvironment(getRuntimeEndpoint()), ...await credentialEnvironment(context) };
}

async function runtimeDirectory(context: Pick<RuntimeContext, 'extensionPath'>): Promise<string> {
	const directory = path.join(context.extensionPath, 'runtime/codypendent');
	let manifest: { platform: string; arch: string; runtimeProducts?: string[] };
	try { manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
	catch { throw new Error(vscode.l10n.t('The bundled Son of Anton agent engine is missing. Reinstall Son of Anton, or build it with scripts/build-codypendent-runtime.mjs.')); }
	if (manifest.platform !== process.platform || manifest.arch !== process.arch) { throw new Error(vscode.l10n.t('The bundled agent engine does not match this machine. Reinstall the matching Son of Anton package.')); }
	if (!manifest.runtimeProducts?.includes('son-of-anton')) { throw new Error(vscode.l10n.t('The bundled agent engine needs an update for independent Son of Anton storage. Rebuild it with scripts/build-codypendent-runtime.mjs.')); }
	return directory;
}

function safeOutput(value: string, environment: NodeJS.ProcessEnv): string {
	for (const [name, secret] of Object.entries(environment)) {
		if (secret && secret.length >= 4 && /key|token|secret|password/i.test(name)) { value = value.split(secret).join('[redacted]'); }
	}
	return value;
}

/** Run a local configuration command without sharing credentials or lifecycle with an external runtime. */
export async function runRuntimeCli(context: RuntimeContext, args: string[], expected: RuntimeEndpoint = getRuntimeEndpoint()): Promise<{ stdout: string; stderr: string }> {
	assertEndpoint(expected);
	if (expected.mode !== 'local') { throw new Error(vscode.l10n.t('The connected external runtime manages its own configuration. Switch to the local Son of Anton runtime to configure it here.')); }
	if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before configuring the agent runtime.')); }
	const directory = await runtimeDirectory(context);
	const environment = await getRuntimeEnvironment(context);
	assertEndpoint(expected);
	try {
		const result = await promisify(execFile)(path.join(directory, 'codypendent'), args, { env: environment, timeout: 20_000, maxBuffer: 128 * 1024 });
		return { stdout: safeOutput(result.stdout, environment), stderr: safeOutput(result.stderr, environment) };
	} catch (error) {
		throw new Error(safeOutput(error instanceof Error ? error.message : String(error), environment));
	}
}

async function listening(socketPath: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = createConnection({ path: socketPath });
		const finish = (value: boolean): void => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
		socket.setTimeout(500, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
	});
}

/** Start only the packaged daemon, retaining the CLI's idle-guarded lifecycle. */
export async function ensureDaemon(context: RuntimeContext, expected: RuntimeEndpoint = getRuntimeEndpoint()): Promise<void> {
	assertEndpoint(expected);
	const socketPath = expected.socketPath;
	if (await listening(socketPath)) { return; }
	assertEndpoint(expected);
	if (expected.mode === 'external') { throw new Error(vscode.l10n.t('The selected external runtime is unavailable. Start it in its owning application, or switch to the local Son of Anton runtime.')); }
	if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace to start the Son of Anton agent engine.')); }
	if (process.platform === 'win32') { throw new Error(vscode.l10n.t('The Rust agent engine currently supports Linux and macOS. Select the native compatibility runtime on Windows.')); }
	if (starting) { await starting; assertEndpoint(expected); return; }
	starting = (async () => {
		await runRuntimeCli(context, ['daemon', 'start'], expected);
		assertEndpoint(expected);
		if (!(await listening(socketPath))) { throw new Error(vscode.l10n.t('The agent engine did not open its socket. Check the Son of Anton runtime logs, then reconnect.')); }
	})().finally(() => { starting = undefined; });
	return starting;
}

/** Open the bundled Rust client for its existing provider/setup and review flows. */
export async function openTerminal(context: vscode.ExtensionContext): Promise<void> {
	const endpoint = getRuntimeEndpoint();
	if (endpoint.mode !== 'local') { throw new Error(vscode.l10n.t('Open the external runtime in its owning application. The Agent Terminal belongs to the local Son of Anton runtime.')); }
	await ensureDaemon(context, endpoint);
	if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before opening the agent terminal.')); }
	const folders = vscode.workspace.workspaceFolders ?? [];
	const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
	if (!folder || folder.uri.scheme !== 'file') { return; }
	const directory = await runtimeDirectory(context);
	const environment = await getRuntimeEnvironment(context);
	assertEndpoint(endpoint);
	const terminal = vscode.window.createTerminal({
		name: vscode.l10n.t('Son of Anton Agent Terminal'), cwd: folder.uri,
		shellPath: path.join(directory, 'codypendent'), shellArgs: [], env: { ...environment, CODYPENDENT_DATA_DIR: null, CODYPENDENT_CONFIG_DIR: null, CODYPENDENT_SOCKET: null }
	});
	context.subscriptions.push(terminal); terminal.show();
}

/** Reuse Codypendent's attributed council service and durable reports. */
export async function openCouncil(context: vscode.ExtensionContext, history = false): Promise<void> {
	const endpoint = getRuntimeEndpoint();
	if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage(vscode.l10n.t('Trust this workspace to run an agent council.')); return; }
	if (endpoint.mode !== 'local') { throw new Error(vscode.l10n.t('Run councils in the external runtime\'s owning application, or switch to the local Son of Anton runtime.')); }
	await ensureDaemon(context, endpoint);
	const directory = await runtimeDirectory(context);
	const binary = path.join(directory, 'codypendent');
	const env = await getRuntimeEnvironment(context);
	const result = await runRuntimeCli(context, ['council', 'list', '--json'], endpoint);
	const parsed: unknown = JSON.parse(result.stdout);
	if (!Array.isArray(parsed)) { throw new Error(vscode.l10n.t('Codypendent returned an invalid council list.')); }
	const names = parsed.filter((item): item is { name: string; description?: string } => !!item && typeof item === 'object' && typeof item.name === 'string');
	if (!names.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Create a council in the Son of Anton Agent Terminal first. Use council create --help for the available options.'));
		return;
	}
	const chosen = await vscode.window.showQuickPick(names.map(item => ({ label: item.name, description: item.description })), { title: vscode.l10n.t('Shared Council') });
	if (!chosen) { return; }
	const folders = vscode.workspace.workspaceFolders ?? [];
	const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
	if (!folder || folder.uri.scheme !== 'file') { return; }
	let args = ['council', 'show', chosen.label, '--last'];
	if (!history) {
		const objective = await vscode.window.showInputBox({ title: vscode.l10n.t('Council Review'), prompt: vscode.l10n.t('What should the council review?'), validateInput: value => value.length > 20_000 ? vscode.l10n.t('Use at most 20,000 characters.') : undefined });
		if (!objective?.trim()) { return; }
		args = ['council', 'run', chosen.label, '--objective', objective, '--repo', folder.uri.fsPath, '--evidence'];
	}
	// VS Code passes an argv array to the binary, never interpolated shell text.
	assertEndpoint(endpoint);
	const terminal = vscode.window.createTerminal({
		name: vscode.l10n.t('Son of Anton Council'), cwd: folder.uri, shellPath: binary, shellArgs: args,
		env: { ...env, CODYPENDENT_DATA_DIR: null, CODYPENDENT_CONFIG_DIR: null, CODYPENDENT_SOCKET: null }
	});
	context.subscriptions.push(terminal); terminal.show();
}
