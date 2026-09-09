/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';

type CleanupResource = 'acp' | 'checkpoint';

/** Complete both independent cleanups before reporting failure, so retries cannot overlap unfinished work. */
export async function cleanupConversationResources(
	id: string,
	operations: Record<CleanupResource, (id: string) => Promise<void>>,
	reportFailure: (resource: CleanupResource, error: unknown) => void,
): Promise<void> {
	const resources: CleanupResource[] = ['acp', 'checkpoint'];
	const results = await Promise.allSettled(resources.map(resource => Promise.resolve().then(() => operations[resource](id))));
	const failures: unknown[] = [];
	for (const [index, result] of results.entries()) {
		if (result.status === 'rejected') {
			failures.push(result.reason); reportFailure(resources[index], result.reason);
		}
	}
	if (failures.length) {
		throw new AggregateError(failures, vscode.l10n.t('Cleanup for the deleted conversation is incomplete. Cleanup will be retried.'));
	}
}
