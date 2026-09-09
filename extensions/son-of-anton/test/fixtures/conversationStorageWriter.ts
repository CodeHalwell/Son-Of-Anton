/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { ConversationDeletedError, ConversationStorage } from '../../src/chat/ConversationStorage';
import type { ConversationRecord } from '../../src/chat/ConversationStore';

const hostProcess = process as NodeJS.Process;
type Scenario = { mode: 'reject' | 'stage'; record: ConversationRecord } | { mode: 'crash'; state: 'pending' | 'deleted' };

/** Child scenarios accept serialized data only; the executed fixture is always this static module. */
async function run(): Promise<void> {
	const storage = new ConversationStorage(hostProcess.argv[2]);
	const scenario = JSON.parse(hostProcess.argv[3]) as Scenario;
	if (scenario.mode === 'reject') {
		await assert.rejects(storage.save(scenario.record), ConversationDeletedError);
	} else if (scenario.mode === 'stage') {
		const internal = storage as unknown as { withLifecycleLock<T>(id: string, operation: () => Promise<T>): Promise<T> };
		const lock = internal.withLifecycleLock; let calls = 0;
		internal.withLifecycleLock = async (id, operation) => {
			if (++calls === 2) {
				hostProcess.stdout.write('staged\n');
				await new Promise<void>(resolve => hostProcess.stdin.once('data', () => resolve()));
			}
			return lock.call(storage, id, operation) as ReturnType<typeof operation>;
		};
		try { await assert.rejects(storage.save(scenario.record), /being deleted|permanently deleted/); }
		finally { hostProcess.stdin.destroy(); }
	} else if (scenario.mode === 'crash') {
		const internal = storage as unknown as { atomicWrite(file: string, body: string): Promise<void> };
		const write = internal.atomicWrite;
		internal.atomicWrite = async (file, body) => {
			await write.call(storage, file, body);
			if (file.endsWith('deletion.json') && JSON.parse(body).state === scenario.state) { hostProcess.exit(0); }
		};
		await storage.delete('conversation');
		throw new Error('The child did not reach its requested crash point.');
	} else {
		throw new Error('Unknown conversation writer scenario.');
	}
}

void run().catch(error => { console.error(error); hostProcess.exitCode = 1; });
