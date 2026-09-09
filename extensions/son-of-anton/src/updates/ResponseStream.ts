/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Read fetch bodies without relying on the optional DOM async-iterator declaration. */
export async function* readResponseBody(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	let complete = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) { complete = true; return; }
			yield value;
		}
	} finally {
		// Size checks, failed writes and cancelled consumers must also stop downloading.
		try { if (!complete) { await reader.cancel().catch(() => undefined); } }
		finally { reader.releaseLock(); }
	}
}
