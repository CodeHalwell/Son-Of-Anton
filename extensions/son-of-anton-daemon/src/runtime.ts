/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveSocketPath, validateSocketPath } from '@codypendent/protocol/node';

let starting: Promise<void> | undefined;

async function listening(socketPath: string): Promise<boolean> {
	return new Promise(resolve => {
		const socket = createConnection({ path: socketPath });
		const finish = (value: boolean): void => { socket.removeAllListeners(); socket.destroy(); resolve(value); };
		socket.setTimeout(500, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
	});
}

/** Start only the packaged daemon, retaining the CLI's idle-guarded lifecycle. */
export async function ensureDaemon(context: vscode.ExtensionContext): Promise<void> {
	const socketPath = vscode.workspace.getConfiguration('sota.daemon').get<string>('socketPath') || resolveSocketPath();
	validateSocketPath(socketPath);
	if (await listening(socketPath)) { return; }
	if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Start Codypendent separately, or trust this workspace to start its bundled runtime.')); }
	if (process.platform === 'win32') { throw new Error(vscode.l10n.t('The shared runtime supports Linux and macOS. Select the native compatibility runtime on Windows.')); }
	if (starting) { return starting; }
	starting = (async () => {
		const directory = path.join(context.extensionPath, 'runtime/codypendent');
		let manifest: { platform: string; arch: string; version: string };
		try { manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
		catch { throw new Error(vscode.l10n.t('The bundled Codypendent runtime is missing. Build it with scripts/build-codypendent-runtime.mjs, or install Codypendent and run codypendent daemon start.')); }
		if (manifest.platform !== process.platform || manifest.arch !== process.arch) { throw new Error(vscode.l10n.t('The bundled runtime does not match this machine. Reinstall the matching Son of Anton package.')); }
		await new Promise<void>((resolve, reject) => {
			execFile(path.join(directory, 'codypendent'), ['daemon', 'start'], {
				env: { ...process.env, CODYPENDENT_SOCKET: socketPath }, timeout: 20_000, maxBuffer: 128 * 1024,
			}, error => error ? reject(new Error(vscode.l10n.t('Codypendent could not start: {0}', error.message))) : resolve());
		});
		if (!(await listening(socketPath))) { throw new Error(vscode.l10n.t('Codypendent did not open its socket. Check its daemon logs, then reconnect.')); }
	})().finally(() => { starting = undefined; });
	return starting;
}

/** Open the bundled Rust client for its existing provider/setup and review flows. */
export async function openTerminal(context: vscode.ExtensionContext): Promise<void> {
	await ensureDaemon(context);
	if (!vscode.workspace.isTrusted) { throw new Error(vscode.l10n.t('Trust this workspace before opening the agent terminal.')); }
	const folders = vscode.workspace.workspaceFolders ?? [];
	const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
	if (!folder || folder.uri.scheme !== 'file') { return; }
	const directory = path.join(context.extensionPath, 'runtime/codypendent');
	const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as { platform: string; arch: string };
	if (manifest.platform !== process.platform || manifest.arch !== process.arch) { throw new Error(vscode.l10n.t('Install the matching Codypendent runtime for this machine.')); }
	const terminal = vscode.window.createTerminal({ name: 'Codypendent', cwd: folder.uri,
		shellPath: path.join(directory, 'codypendent'), shellArgs: [], env: {
			CODYPENDENT_SOCKET: vscode.workspace.getConfiguration('sota.daemon').get<string>('socketPath') || resolveSocketPath(),
		} });
	context.subscriptions.push(terminal); terminal.show();
}

/** Reuse Codypendent's attributed council service and durable reports. */
export async function openCouncil(context: vscode.ExtensionContext, history = false): Promise<void> {
	if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage(vscode.l10n.t('Trust this workspace to use shared councils. Council runs and reports are managed by Codypendent.')); return; }
	await ensureDaemon(context);
	const directory = path.join(context.extensionPath, 'runtime/codypendent');
	const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as { platform: string; arch: string };
	if (manifest.platform !== process.platform || manifest.arch !== process.arch) { throw new Error(vscode.l10n.t('Install the matching Codypendent runtime for this machine.')); }
	const binary = path.join(directory, 'codypendent');
	const env = { ...process.env, CODYPENDENT_SOCKET: vscode.workspace.getConfiguration('sota.daemon').get<string>('socketPath') || resolveSocketPath() };
	const result = await promisify(execFile)(binary, ['council', 'list', '--json'], { env, timeout: 10_000, maxBuffer: 1024 * 1024 });
	const parsed: unknown = JSON.parse(result.stdout);
	if (!Array.isArray(parsed)) { throw new Error(vscode.l10n.t('Codypendent returned an invalid council list.')); }
	const names = parsed.filter((item): item is { name: string; description?: string } => !!item && typeof item === 'object' && typeof item.name === 'string');
	if (!names.length) {
		void vscode.window.showInformationMessage(vscode.l10n.t('Create a council in Codypendent first. Open its terminal and run codypendent council create --help.'));
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
	const terminal = vscode.window.createTerminal({ name: vscode.l10n.t('Codypendent Council'), cwd: folder.uri, shellPath: binary, shellArgs: args, env });
	context.subscriptions.push(terminal); terminal.show();
}
