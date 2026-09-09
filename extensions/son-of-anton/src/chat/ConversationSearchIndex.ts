/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import type { ChatMessage } from './ChatPanel';

export const MAX_HISTORY_QUERY_LENGTH = 1000;
const TEXT_CHUNK_LENGTH = 16_384;
// Unicode lowercasing can expand a character; this also bounds overlap after normalization.
const MAX_NORMALIZED_QUERY_LENGTH = MAX_HISTORY_QUERY_LENGTH * 3;
const SEARCH_VERSION = 'sota-search-1\n';

/** Bounded overlapping chunks preserve substring matches across chunk boundaries. Images never enter this index. */
export function* conversationTextChunks(messages: readonly ChatMessage[]): Generator<string> {
	for (const message of messages) {
		const texts = typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.type === 'text' ? part.text : '');
		// Preserve the previous search's space separator between structured text parts.
		let tail = '';
		for (let index = 0; index < texts.length; index++) {
			const text = texts[index];
			if (index) { tail += ' '; }
			for (let offset = 0; offset < text.length; offset += TEXT_CHUNK_LENGTH) {
				const chunk = (tail + text.slice(offset, offset + TEXT_CHUNK_LENGTH)).toLowerCase();
				yield chunk;
				tail = chunk.slice(-(MAX_NORMALIZED_QUERY_LENGTH - 1));
			}
		}
	}
}

export async function writeSearchIndex(file: string, messages: readonly ChatMessage[]): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`; const hash = createHash('sha256');
	try {
		const output = await fsp.open(temporary, 'wx', 0o600);
		try {
			const source = await fsp.stat(file.slice(0, -7));
			await output.writeFile(SEARCH_VERSION + JSON.stringify({ size: source.size, mtimeMs: source.mtimeMs, ctimeMs: source.ctimeMs }) + '\n');
			for (const chunk of conversationTextChunks(messages)) { const line = `${JSON.stringify(chunk)}\n`; hash.update(line); await output.writeFile(line); }
			await output.writeFile(`${hash.digest('hex')}\n`);
		} finally { await output.close(); }
		await fsp.rename(temporary, file);
	} finally { await fsp.rm(temporary, { force: true }); }
}

/** Read bounded lines without allocating a full transcript or search index. */
export async function searchIndexMatches(file: string, query: string, signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted();
	const source = await fsp.stat(file.slice(0, -7));
	const input = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 32_768, signal });
	let pending = ''; let header = false; let sourceValidated = false; let digest: string | undefined; let matched = false; const hash = createHash('sha256');
	try {
		for await (const chunk of input) {
			signal?.throwIfAborted(); pending += chunk;
			let newline: number;
			while ((newline = pending.indexOf('\n')) >= 0) {
				const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
				if (!header) { if (`${line}\n` !== SEARCH_VERSION) { throw new Error('Invalid conversation search index.'); } header = true; continue; }
				if (!sourceValidated) {
					const indexed = JSON.parse(line) as { size: number; mtimeMs: number; ctimeMs: number };
					if (indexed.size !== source.size || indexed.mtimeMs !== source.mtimeMs || indexed.ctimeMs !== source.ctimeMs) { throw new Error('Conversation search index needs refreshing.'); }
					sourceValidated = true; continue;
				}
				if (digest !== undefined) { throw new Error('Invalid conversation search index trailer.'); }
				if (/^[a-f0-9]{64}$/.test(line)) { digest = line; continue; }
				const text = JSON.parse(line) as string;
				if (typeof text !== 'string' || text.length > TEXT_CHUNK_LENGTH * 3 + MAX_NORMALIZED_QUERY_LENGTH * 2) { throw new Error('Invalid conversation search text chunk.'); }
				hash.update(`${line}\n`); if (text.includes(query)) { matched = true; }
			}
			if (pending.length > (TEXT_CHUNK_LENGTH * 3 + MAX_NORMALIZED_QUERY_LENGTH * 2) * 6 + 2) { throw new Error('Conversation search index line is too large.'); }
			// Even cached files must yield between bounded reads so superseding queries can cancel.
			await new Promise<void>(resolve => setImmediate(resolve));
		}
		if (pending || !header || !sourceValidated || digest !== hash.digest('hex')) { throw new Error('Conversation search index failed its integrity check.'); }
		return matched;
	} finally { input.destroy(); }
}

/** Legacy JSON parsing runs outside the extension host; a cancelled query terminates its worker. */
export async function buildLegacySearchIndex(page: string, destination: string, query: string, signal?: AbortSignal): Promise<{ matched: boolean; cacheError?: string }> {
	signal?.throwIfAborted();
	const temporary = `${destination}.${randomUUID()}.tmp`;
	const worker = new Worker(String.raw`
		const fs = require('node:fs'); const { createHash } = require('node:crypto');
		const { parentPort, workerData } = require('node:worker_threads');
		try {
			const input = fs.openSync(workerData.page, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
			let body; let source;
			try {
				const info = fs.fstatSync(input); const size = info.size;
				if (!info.isFile() || size > 64 * 1024 * 1024) { throw new Error('This legacy message page exceeds the 64 MiB search-indexing limit or is not a regular file. Its history is preserved; open and save the conversation to refresh its search index.'); }
				const buffer = Buffer.allocUnsafe(size + 1); let read = 0;
				while (read < buffer.length) { const bytes = fs.readSync(input, buffer, read, buffer.length - read, null); if (!bytes) { break; } read += bytes; }
				const after = fs.fstatSync(input); const current = fs.lstatSync(workerData.page);
				if (read !== size || after.size !== size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || !current.isFile() || current.dev !== info.dev || current.ino !== info.ino) { throw new Error('Conversation message page changed while indexing.'); }
				body = buffer.subarray(0, size).toString('utf8'); source = { size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
			} finally { fs.closeSync(input); }
			if (createHash('sha256').update(body).digest('hex') + '.json' !== require('node:path').basename(workerData.page)) { throw new Error('Conversation message page failed its integrity check.'); }
			const messages = JSON.parse(body);
			if (!Array.isArray(messages) || messages.length > 100) { throw new Error('Invalid conversation message page.'); }
			let output; let cacheError; let matched = false; const hash = createHash('sha256');
			try { output = fs.openSync(workerData.temporary, 'wx', 0o600); } catch (error) { cacheError = error.message; }
			const write = text => { if (output !== undefined) { try { fs.writeSync(output, text); } catch (error) { cacheError = error.message; fs.closeSync(output); output = undefined; } } };
			try {
				write('sota-search-1\n' + JSON.stringify(source) + '\n');
				for (const message of messages) {
					const texts = typeof message.content === 'string' ? [message.content] : message.content.filter(part => part.type === 'text').map(part => part.text);
					let tail = '';
					for (let index = 0; index < texts.length; index++) {
						if (index) { tail += ' '; }
						for (let offset = 0; offset < texts[index].length; offset += workerData.chunkLength) {
							const chunk = (tail + texts[index].slice(offset, offset + workerData.chunkLength)).toLowerCase();
							if (chunk.includes(workerData.query)) { matched = true; }
							const line = JSON.stringify(chunk) + '\n'; hash.update(line); write(line); tail = chunk.slice(-(workerData.overlap - 1));
						}
					}
				}
				write(hash.digest('hex') + '\n');
			} finally { if (output !== undefined) { fs.closeSync(output); } }
			parentPort.postMessage({ complete: true, matched, cacheError });
		} catch (error) { parentPort.postMessage({ error: error.message }); }
	`, { eval: true, workerData: { page, temporary, query, chunkLength: TEXT_CHUNK_LENGTH, overlap: MAX_NORMALIZED_QUERY_LENGTH }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
	worker.unref();
	let abort: (() => void) | undefined;
	try {
		const result = await new Promise<{ matched: boolean; cacheError?: string }>((resolve, reject) => {
			abort = () => { reject(signal?.reason ?? new Error('Search cancelled')); void worker.terminate(); };
			signal?.addEventListener('abort', abort, { once: true });
			worker.once('message', (message: { complete?: boolean; matched: boolean; cacheError?: string; error?: string }) => { if (message.complete) { resolve(message); } else { reject(new Error(message.error ?? 'Conversation search indexing failed.')); } });
			worker.once('error', reject);
			worker.once('exit', code => { if (code !== 0) { reject(new Error('Conversation search indexing worker stopped.')); } });
			if (signal?.aborted) { abort(); }
		});
		signal?.throwIfAborted();
		if (!result.cacheError) { try { await fsp.rename(temporary, destination); } catch (error) { result.cacheError = error instanceof Error ? error.message : String(error); } }
		return result;
	} finally {
		if (abort) { signal?.removeEventListener('abort', abort); }
		await worker.terminate();
		try { await fsp.rm(temporary, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') { throw error; } }
	}
}
