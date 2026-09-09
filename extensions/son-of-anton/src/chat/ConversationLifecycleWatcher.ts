/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import { RelativePattern, Uri, workspace, type Disposable } from 'vscode';

/** Observe lifecycle markers outside the workspace; the owner validates and reconciles their contents. */
export function watchConversationLifecycle(directory: string, onChange: () => void): Disposable {
	// RelativePattern watches missing roots when they appear. Keep the recursive
	// scope inside lifecycle metadata rather than watching transcript page writes.
	const root = path.join(directory, '.lifecycle');
	const watcher = workspace.createFileSystemWatcher(new RelativePattern(Uri.file(root), '**'));
	const disposables: Disposable[] = [watcher];
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = () => {
		if (disposed || timer !== undefined) { return; }
		// A fixed coalescing window also bounds latency during a continuous event burst.
		timer = setTimeout(() => { timer = undefined; if (!disposed) { onChange(); } }, 25);
	};
	const onFileEvent = (uri: Uri) => {
		const relative = path.relative(root, uri.fsPath);
		// Root/container events cover missing-root resume and coalesced folder
		// deletion. Ignore commit-ticket churn and every non-marker file event.
		if (uri.scheme === 'file' && (!relative || /^[a-f0-9]{64}(?:[/\\]deletion\.json)?$/.test(relative))) { schedule(); }
	};
	const dispose = () => {
		if (disposed) { return; }
		disposed = true; clearTimeout(timer); timer = undefined;
		for (const disposable of disposables) { disposable.dispose(); }
	};
	try {
		disposables.push(watcher.onDidCreate(onFileEvent));
		disposables.push(watcher.onDidChange(onFileEvent));
		disposables.push(watcher.onDidDelete(onFileEvent));
		// Reconcile once after subscription so changes during setup are not missed.
		schedule();
	} catch (error) { dispose(); throw error; }
	return { dispose };
}
