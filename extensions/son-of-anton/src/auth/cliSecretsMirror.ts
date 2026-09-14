/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SECRET_KEYS } from 'son-of-anton-core/credentials/credentialDetection';
import { ProtectedSecretStore } from 'son-of-anton-core/credentials/ProtectedSecretStore';

const protectedStore = new ProtectedSecretStore();
let pending: Promise<void> = Promise.resolve();

/** Serialize reads with saves so an older sweep cannot overwrite a newer deletion. */
function syncKey(secrets: vscode.SecretStorage, key: string, removeAbsent: boolean): Promise<void> {
	const operation = pending.catch(() => {}).then(async () => {
		const value = await secrets.get(key);
		if (value?.trim()) {
			if (await protectedStore.get(key) !== value) { await protectedStore.store(key, value); }
		} else if (removeAbsent) { await protectedStore.delete(key); }
	});
	pending = operation;
	return operation;
}

/** Share IDE credentials with the CLI through the operating system's protected store. */
export async function mirrorSecretsToCliStore(secrets: vscode.SecretStorage): Promise<number> {
	let written = 0;
	for (const key of Object.values(SECRET_KEYS)) {
		if (await secrets.get(key)) { await syncKey(secrets, key, false); written++; }
	}
	return written;
}

export function watchSecretsForCliMirror(secrets: vscode.SecretStorage): vscode.Disposable {
	return secrets.onDidChange(event => {
		if (Object.values(SECRET_KEYS).includes(event.key as typeof SECRET_KEYS[keyof typeof SECRET_KEYS])) {
			void syncKey(secrets, event.key, true).catch(() => {
				void vscode.window.showWarningMessage('CLI credential synchronization failed. Check your operating system credential store; IDE credentials remain available.');
			});
		}
	});
}
