/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { readResponseBody } from '../src/updates/ResponseStream';

suite('Updater response streams', () => {
	test('reads every chunk and releases the reader after completion', async () => {
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('first')); controller.enqueue(Buffer.from('second')); controller.close(); } });
		const chunks: Uint8Array[] = [];
		for await (const chunk of readResponseBody(stream)) { chunks.push(chunk); }
		assert.deepEqual({ body: Buffer.concat(chunks).toString(), locked: stream.locked }, { body: 'firstsecond', locked: false });
	});
	test('a rejected download cancels the remaining bytes and preserves the consumer error', async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('oversized')); }, cancel() { cancelled = true; throw new Error('secondary cancellation failure'); } });
		await assert.rejects(async () => {
			for await (const _chunk of readResponseBody(stream)) { throw new Error('Installer exceeds its declared size.'); }
		}, /Installer exceeds its declared size/);
		assert.deepEqual({ cancelled, locked: stream.locked }, { cancelled: true, locked: false });
	});
	test('an interrupted response releases its lock and reports the download failure', async () => {
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('network disconnected')); } });
		await assert.rejects(async () => { for await (const _chunk of readResponseBody(stream)) { assert.fail('No bytes should be returned.'); } }, /network disconnected/);
		assert.equal(stream.locked, false);
	});
});
