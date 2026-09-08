/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import type { ServerResponse } from 'node:http';

/** Wait for a slow client without retaining an unbounded queue of provider chunks. */
export async function writeResponse(res: ServerResponse, chunk: string | Uint8Array, signal: AbortSignal): Promise<void> {
	if (signal.aborted || res.destroyed) { throw new DOMException('Request cancelled', 'AbortError'); }
	if (res.write(chunk)) { return; }
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); signal.removeEventListener('abort', closed); };
		const drained = (): void => { cleanup(); resolve(); };
		const closed = (): void => { cleanup(); reject(new DOMException('Request cancelled', 'AbortError')); };
		const failed = (error: Error): void => { cleanup(); reject(error); };
		res.once('drain', drained);
		res.once('close', closed);
		res.once('error', failed);
		signal.addEventListener('abort', closed, { once: true });
		if (signal.aborted || res.destroyed) { closed(); }
	});
}
