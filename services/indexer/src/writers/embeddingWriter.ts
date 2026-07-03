// Son of Anton — Embedding Writer
// Generates embeddings for code chunks and writes them to Qdrant.

import crypto from 'crypto';
import { QdrantClient, CodeChunkPoint, CodeChunkPayload } from '../clients/qdrant';
import {
	FileExtractionResult,
	ExtractedFunction,
	ExtractedClass,
	ExtractedType,
} from '../extractors/symbolExtractor';
import { IndexerConfig } from '../config';
import { EmbeddingProvider, MockEmbeddingProvider } from '../../_lib/embeddings/dist/index.js';

// Re-exported so existing consumers keep working; the implementations now
// live in the shared `services/_lib/embeddings` module, which the mcp-gateway
// also vendors — queries and documents must be embedded identically.
export { EmbeddingProvider, MockEmbeddingProvider };

/** Represents a code chunk ready for embedding. */
export interface CodeChunk {
	id: string;
	content: string;
	payload: CodeChunkPayload;
}

export class EmbeddingWriter {
	private readonly qdrant: QdrantClient;
	private readonly provider: EmbeddingProvider;
	private readonly batchSize: number;
	/** Chunk ID → content hash, for change detection. */
	private readonly chunkHashes = new Map<string, string>();
	/** File path → chunk IDs currently stored for that file, for stale-point cleanup. */
	private readonly fileChunkIds = new Map<string, Set<string>>();
	/**
	 * Content hash → embedding vector. Keyed by content (not chunk ID) so a
	 * renamed or moved symbol whose body is unchanged reuses its vector
	 * instead of paying for a re-embed (F-2). Insertion-order bounded.
	 */
	private readonly vectorCache = new Map<string, number[]>();
	private static readonly VECTOR_CACHE_MAX = 20_000;

	constructor(qdrant: QdrantClient, provider: EmbeddingProvider, config: IndexerConfig) {
		this.qdrant = qdrant;
		this.provider = provider;
		this.batchSize = config.embedding.batchSize;
	}

	/**
	 * Process a file extraction result and write embeddings for its chunks.
	 *
	 * Incremental behaviour:
	 * - Unchanged chunks are left untouched in Qdrant (not deleted, not re-upserted).
	 * - Chunks whose content hash matches a cached vector (e.g. a renamed or
	 *   moved symbol) are upserted with the cached vector — no provider call.
	 * - Only genuinely new content is sent to the embedding provider.
	 * - Chunk IDs that disappeared from the file are deleted from Qdrant.
	 *
	 * Returns the number of points upserted.
	 */
	async writeFile(
		filePath: string,
		language: string,
		extraction: FileExtractionResult
	): Promise<number> {
		const chunks = this.buildChunks(filePath, language, extraction);
		const currentIds = new Set(chunks.map(c => c.id));
		const previousIds = this.fileChunkIds.get(filePath);

		let changedChunks: CodeChunk[];
		if (previousIds === undefined) {
			// First visit to this file in this process: clear whatever an
			// earlier run left behind, then write every current chunk.
			await this.qdrant.deleteByFilePath(filePath);
			changedChunks = chunks;
		} else {
			const staleIds = [...previousIds].filter(id => !currentIds.has(id));
			if (staleIds.length > 0) {
				await this.qdrant.deletePoints(staleIds);
				for (const id of staleIds) {
					this.chunkHashes.delete(id);
				}
			}
			changedChunks = chunks.filter(
				chunk => this.chunkHashes.get(chunk.id) !== chunk.payload.contentHash
			);
		}

		let upsertedCount = 0;
		for (let i = 0; i < changedChunks.length; i += this.batchSize) {
			const batch = changedChunks.slice(i, i + this.batchSize);
			const vectors = await this.vectorsFor(batch);

			const points: CodeChunkPoint[] = batch.map((chunk, idx) => ({
				id: chunk.id,
				vector: vectors[idx],
				payload: chunk.payload,
			}));

			await this.qdrant.upsertPoints(points);
			upsertedCount += points.length;

			for (const chunk of batch) {
				this.chunkHashes.set(chunk.id, chunk.payload.contentHash);
			}
		}

		this.fileChunkIds.set(filePath, currentIds);
		return upsertedCount;
	}

	/**
	 * Resolve vectors for a batch, reusing content-hash-cached vectors and
	 * embedding only cache misses (deduplicated by content hash).
	 */
	private async vectorsFor(batch: CodeChunk[]): Promise<number[][]> {
		const missesByHash = new Map<string, string>();
		for (const chunk of batch) {
			const hash = chunk.payload.contentHash;
			if (!this.vectorCache.has(hash) && !missesByHash.has(hash)) {
				missesByHash.set(hash, chunk.content);
			}
		}

		if (missesByHash.size > 0) {
			const hashes = [...missesByHash.keys()];
			const embedded = await this.provider.embed(
				hashes.map(h => missesByHash.get(h)!),
				'document'
			);
			for (let i = 0; i < hashes.length; i++) {
				this.cacheVector(hashes[i], embedded[i]);
			}
		}

		return batch.map(chunk => this.vectorCache.get(chunk.payload.contentHash)!);
	}

	private cacheVector(contentHash: string, vector: number[]): void {
		if (this.vectorCache.size >= EmbeddingWriter.VECTOR_CACHE_MAX) {
			const oldest = this.vectorCache.keys().next().value;
			if (oldest !== undefined) {
				this.vectorCache.delete(oldest);
			}
		}
		this.vectorCache.set(contentHash, vector);
	}

	private buildChunks(
		filePath: string,
		language: string,
		extraction: FileExtractionResult
	): CodeChunk[] {
		const chunks: CodeChunk[] = [];
		const now = new Date().toISOString();

		// Functions as individual chunks
		for (const fn of extraction.functions) {
			chunks.push(this.createChunk(
				filePath, language, 'function', fn.name,
				fn.startLine, fn.endLine, fn.body, fn.contentHash, now
			));
		}

		// Classes as chunks (methods are included in the class body)
		for (const cls of extraction.classes) {
			chunks.push(this.createChunk(
				filePath, language, 'class', cls.name,
				cls.startLine, cls.endLine, cls.body, cls.contentHash, now
			));

			// If the class is large, also create individual method chunks
			for (const method of cls.methods) {
				if (method.endLine - method.startLine > 10) {
					chunks.push(this.createChunk(
						filePath, language, 'function', method.qualifiedName,
						method.startLine, method.endLine, method.body, method.contentHash, now
					));
				}
			}
		}

		// Types as chunks
		for (const t of extraction.types) {
			chunks.push(this.createChunk(
				filePath, language, 'type', t.name,
				t.startLine, t.endLine, t.body, t.contentHash, now
			));
		}

		// Import block as a single chunk per file
		if (extraction.imports.length > 0) {
			const importContent = extraction.imports
				.map(i => `import ${i.specifiers.join(', ')} from '${i.source}'`)
				.join('\n');
			const importHash = crypto.createHash('sha256').update(importContent).digest('hex');
			const firstLine = Math.min(...extraction.imports.map(i => i.line));
			const lastLine = Math.max(...extraction.imports.map(i => i.line));

			chunks.push(this.createChunk(
				filePath, language, 'import', 'imports',
				firstLine, lastLine, importContent, importHash, now
			));
		}

		return chunks;
	}

	private createChunk(
		filePath: string,
		language: string,
		chunkType: CodeChunkPayload['chunkType'],
		symbolName: string,
		startLine: number,
		endLine: number,
		content: string,
		contentHash: string,
		lastModified: string
	): CodeChunk {
		// Use a deterministic ID based on file + symbol for stable upserts
		const id = crypto.createHash('sha256')
			.update(`${filePath}:${chunkType}:${symbolName}:${startLine}`)
			.digest('hex');

		return {
			id,
			content,
			payload: {
				filePath,
				chunkType,
				symbolName,
				startLine,
				endLine,
				language,
				lastModified,
				contentHash,
				content,
			},
		};
	}
}
