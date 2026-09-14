/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/** Check and read the same open file, enforcing the limit even if it grows during the read. */
export async function readBoundedFile(filename: string, maxBytes: number, noFollow = false) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) { throw new Error('Invalid file size limit'); }
	const handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > maxBytes) { throw new Error('File is not regular or exceeds its size limit'); }
		const buffer = Buffer.alloc(maxBytes + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
			if (!bytesRead) { break; }
			size += bytesRead;
		}
		if (size > maxBytes) { throw new Error('File exceeds its size limit'); }
		return { content: buffer.toString('utf8', 0, size), info };
	} finally { await handle.close(); }
}
