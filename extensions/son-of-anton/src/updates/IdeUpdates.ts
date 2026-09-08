/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { arch } from 'node:os';
import { createHash } from 'node:crypto';
import { IDE_REPOSITORY, eligibleReleases, installerForRelease, releaseAssetUrl, type IdeRelease, type ReleaseChannel } from './ReleaseManifest';

const MAX_METADATA_BYTES = 2 * 1024 * 1024;
async function boundedText(response: Response): Promise<string> {
	if (!response.ok || !response.body) { throw new Error(vscode.l10n.t('Release service returned HTTP {0}.', response.status)); }
	const chunks: Uint8Array[] = []; let length = 0;
	for await (const chunk of response.body) {
		length += chunk.byteLength;
		if (length > MAX_METADATA_BYTES) { throw new Error(vscode.l10n.t('Release metadata is too large.')); }
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}
async function readInstalledBuild(): Promise<{ commit?: string; date?: string }> {
	try { return JSON.parse(await fs.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8')); } catch { return {}; }
}

/** Download is explicit, streamed to disk, cancellable, and verified before an installer can be opened. */
export function registerIdeUpdates(context: vscode.ExtensionContext): void {
	let busy = false, disposed = false;
	const abort = new AbortController();
	context.subscriptions.push({ dispose: () => { disposed = true; abort.abort(); } });
	const channel = (): ReleaseChannel => vscode.workspace.getConfiguration('sota').get('updates.channel') === 'preview' ? 'preview' : 'stable';
	const list = async (): Promise<IdeRelease[]> => {
		const response = await fetch(`https://api.github.com/repos/${IDE_REPOSITORY}/releases?per_page=100`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Son-of-Anton-IDE' }, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) });
		const releases = JSON.parse(await boundedText(response)) as IdeRelease[];
		if (!Array.isArray(releases)) { throw new Error(vscode.l10n.t('Invalid release list.')); }
		return eligibleReleases(releases, channel());
	};
	const run = async (rollback = false, quiet = false): Promise<void> => {
		if (busy || disposed) { return; }
		busy = true;
		try {
			const installed = await readInstalledBuild(), releases = await list();
			const currentVersion = `ide-v${vscode.version}`;
			const installedAt = installed.date ? Date.parse(installed.date) : NaN;
			const candidates = releases.filter(release => rollback
				? Number.isFinite(installedAt) && Date.parse(release.published_at) < installedAt
				: Number.isFinite(installedAt) ? Date.parse(release.published_at) > installedAt : release.tag_name.localeCompare(currentVersion, undefined, { numeric: true }) > 0);
			if (!candidates.length) {
				if (!quiet) { await vscode.window.showInformationMessage(rollback ? vscode.l10n.t('No earlier published installer is available for this build and channel.') : vscode.l10n.t('No newer published IDE release is available on the {0} channel.', channel())); }
				return;
			}
			if (quiet) {
				const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Son of Anton {0} is available.', candidates[0].tag_name), vscode.l10n.t('Review Update'));
				if (!choice || disposed) { return; }
			}
			const selected = await vscode.window.showQuickPick(candidates.map(release => ({ label: release.name || release.tag_name, description: release.published_at.slice(0, 10), detail: release.prerelease ? vscode.l10n.t('Preview release') : vscode.l10n.t('Stable release'), release })), { title: rollback ? vscode.l10n.t('Choose an Earlier IDE Installer') : vscode.l10n.t('Choose an IDE Update'), placeHolder: vscode.l10n.t('The installer is downloaded and verified before you choose to open it.') });
			if (!selected || disposed) { return; }
			const release = selected.release, manifestAsset = release.assets.find(asset => asset.name === 'build-manifest.json');
			if (!manifestAsset) { throw new Error(vscode.l10n.t('This release predates verified IDE updates. Download it from GitHub manually.')); }
			const manifest = await boundedText(await fetch(releaseAssetUrl(manifestAsset.browser_download_url, release.tag_name, manifestAsset.name), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]) }));
			const installer = installerForRelease(release, manifest, `${process.platform}-${arch()}`, channel());
			if (installer.commit === installed.commit) { await vscode.window.showInformationMessage(vscode.l10n.t('This build is already installed.')); return; }
			const folder = path.join(context.globalStorageUri.fsPath, 'updates', release.tag_name), destination = path.join(folder, installer.name);
			await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Downloading {0}', installer.name), cancellable: true }, async (progress, token) => {
				const cancel = new AbortController(), subscription = token.onCancellationRequested(() => cancel.abort());
				if (token.isCancellationRequested) { cancel.abort(); }
				await fs.mkdir(folder, { recursive: true });
				const temporary = `${destination}.${Date.now()}.partial`;
				try {
					const response = await fetch(installer.url, { signal: AbortSignal.any([abort.signal, cancel.signal, AbortSignal.timeout(20 * 60_000)]) });
					if (!response.ok || !response.body) { throw new Error(vscode.l10n.t('Installer download failed with HTTP {0}.', response.status)); }
					const file = await fs.open(temporary, 'wx', 0o600), hash = createHash('sha256'); let bytes = 0;
					try {
						for await (const chunk of response.body) {
							bytes += chunk.byteLength;
							if (bytes > installer.bytes) { throw new Error(vscode.l10n.t('Installer exceeds its declared size.')); }
							hash.update(chunk); await file.writeFile(chunk); progress.report({ increment: chunk.byteLength / installer.bytes * 100 });
						}
					} finally { await file.close(); }
					if (bytes !== installer.bytes || hash.digest('hex') !== installer.sha256) { throw new Error(vscode.l10n.t('Installer checksum verification failed. The download was discarded.')); }
					await fs.rm(destination, { force: true }); await fs.rename(temporary, destination);
				} finally { subscription.dispose(); await fs.rm(temporary, { force: true }); }
			});
			if (disposed) { return; }
			const open = vscode.l10n.t('Open Installer'), reveal = vscode.l10n.t('Reveal Download');
			const choice = await vscode.window.showInformationMessage(vscode.l10n.t('SHA-256 verified. Build signing: {0}. Save your work before replacing the app. Your operating system checks the installer signature when opened.', installer.signing), open, reveal);
			if (choice === open) { await vscode.env.openExternal(vscode.Uri.file(destination)); }
			else if (choice === reveal) { await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(destination)); }
		} catch (error) {
			if (!disposed && !quiet) { await vscode.window.showErrorMessage(vscode.l10n.t('IDE update failed: {0}', error instanceof Error ? error.message : String(error))); }
		} finally { busy = false; }
	};
	context.subscriptions.push(vscode.commands.registerCommand('sota.checkForIdeUpdates', () => run()), vscode.commands.registerCommand('sota.rollbackIdeUpdate', () => run(true)));
	if (vscode.workspace.getConfiguration('sota').get('updates.checkOnStartup', false)) { void run(false, true); }
}
