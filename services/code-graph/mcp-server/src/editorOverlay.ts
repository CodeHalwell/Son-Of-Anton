/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { CodegraphEngine, FileSummary, SearchHit, SymbolMatch } from './engine.js';

export interface OverlayDocument {
	path: string;
	version: number;
	language: string;
	text: string;
	symbols: FileSummary['symbols'];
	outlineAvailable: boolean;
}
export interface OverlaySnapshot { workspace: string; revision: number; documents: OverlayDocument[] }
const canonical = (value: string): string => { try { return realpathSync(value); } catch { try { return path.join(realpathSync(path.dirname(value)), path.basename(value)); } catch { return path.resolve(value); } } };

/** In-memory editor data only. Nothing from this class is indexed, embedded remotely, or written to SQLite. */
export class EditorOverlay {
	private documents = new Map<string, OverlayDocument>();
	private revision = -1;
	private readonly root: string;
	constructor(workspace: string) { this.root = canonical(workspace); }
	get size(): number { return this.documents.size; }
	get status(): object { return { revision: this.revision, documents: [...this.documents.values()].map(({ path, version, outlineAvailable }) => ({ path, version, outlineAvailable })), retrieval: 'LSP outlines and local text matching; persisted dependencies exclude unsaved edits' }; }
	private filename(value: string): string { return canonical(path.resolve(this.root, value)); }
	apply(snapshot: OverlaySnapshot): boolean {
		if (canonical(snapshot.workspace) !== this.root || !Number.isSafeInteger(snapshot.revision) || snapshot.revision <= this.revision || !Array.isArray(snapshot.documents) || snapshot.documents.length > 32) { return false; }
		const next = new Map<string, OverlayDocument>(); let bytes = 0;
		for (const document of snapshot.documents) {
			if (!document || typeof document.path !== 'string' || typeof document.text !== 'string' || typeof document.language !== 'string' || !Number.isSafeInteger(document.version) || !Array.isArray(document.symbols) || document.symbols.length > 1000) { return false; }
			const filename = this.filename(document.path);
			if (!filename.startsWith(this.root + path.sep)) { return false; }
			const length = Buffer.byteLength(document.text); bytes += length;
			if (length > 256 * 1024 || bytes > 2 * 1024 * 1024) { return false; }
			if (document.symbols.some(symbol => typeof symbol.name !== 'string' || typeof symbol.kind !== 'string' || !Number.isSafeInteger(symbol.start) || !Number.isSafeInteger(symbol.end) || symbol.start < 0 || symbol.end < symbol.start || symbol.end > length)) { return false; }
			const previous = this.documents.get(filename);
			if (previous && previous.version > document.version) { return false; }
			next.set(filename, { ...document, path: filename });
		}
		this.documents = next; this.revision = snapshot.revision; return true;
	}
	contains(filename: string): boolean { return this.documents.has(this.filename(filename)); }
	fileSummary(engine: CodegraphEngine, filename: string): FileSummary & { source?: string; documentVersion?: number; outlineAvailable?: boolean } {
		const document = this.documents.get(this.filename(filename));
		return document ? { path: document.path, language: document.language, symbols: document.symbols, source: 'unsaved-editor', documentVersion: document.version, outlineAvailable: document.outlineAvailable } : engine.fileSummary(filename);
	}
	symbolLookup(engine: CodegraphEngine, query: string, limit: number): (SymbolMatch & { source?: string; documentVersion?: number })[] {
		const lowered = query.toLowerCase();
		const matches = [...this.documents.values()].flatMap(document => document.symbols.filter(symbol => symbol.name.toLowerCase().includes(lowered)).map(symbol => ({ ...symbol, file: document.path, source: 'unsaved-editor', documentVersion: document.version })));
		return [...matches, ...engine.symbolLookup(query, Math.min(100, limit + 32)).filter(match => !this.contains(match.file))].sort((a, b) => Number(b.name.toLowerCase() === lowered) - Number(a.name.toLowerCase() === lowered)).slice(0, limit);
	}
	search(query: string, saved: SearchHit[], limit: number, scope?: string[]): (SearchHit & { source?: string; documentVersion?: number; retrieval?: string })[] {
		const terms = query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length > 1);
		const hits = [...this.documents.values()].filter(document => !scope?.length || scope.some(prefix => document.path === this.filename(prefix) || document.path.startsWith(this.filename(prefix) + path.sep))).flatMap(document => {
			const bytes = Buffer.from(document.text);
			const symbols = document.symbols.length ? document.symbols : [{ name: path.basename(document.path), kind: 'file', start: 0, end: bytes.length }];
			return symbols.map(symbol => {
				const text = bytes.subarray(symbol.start, symbol.end).toString('utf8');
				const matches = terms.filter(term => `${symbol.name} ${text}`.toLowerCase().includes(term)).length;
				return { symbol: symbol.name, file: document.path, kind: symbol.kind, snippet: text.slice(0, 8000), score: terms.length ? matches / terms.length : 0, source: 'unsaved-editor', documentVersion: document.version, retrieval: 'local-text-match' };
			}).filter(hit => hit.score > 0);
		});
		// Saved snippets for dirty files are removed even when the new buffer does not match the query.
		return [...hits.sort((a, b) => b.score - a.score), ...saved.filter(hit => !this.contains(hit.file))].slice(0, limit);
	}
}

/**
 * Keep one acyclic witness per dependency edge, including alternate routes to an
 * already discovered file. Query each file once, using its shortest BFS witness;
 * enumerating every equivalent root path would grow exponentially in diamonds.
 */
export function dependencyImpact(engine: CodegraphEngine, target: string, depth: number): { fileBased: true; paths: string[][]; truncated: boolean } {
	const queue = [[target]], seen = new Set([target]), paths: string[][] = [];
	const maxNodes = 200, maxPaths = 1000, maxExaminedEdges = 10_000;
	let truncated = false, examinedEdges = 0;
	for (let index = 0; index < queue.length; index++) {
		const chain = queue[index];
		if (chain.length > depth) { continue; }
		const callers = new Set<string>();
		for (const caller of engine.impactAnalysis(chain[0], 1)) {
			if (++examinedEdges > maxExaminedEdges) { return { fileBased: true, paths, truncated: true }; }
			if (callers.has(caller) || chain.includes(caller)) { continue; }
			callers.add(caller);
			const discovered = seen.has(caller);
			if (!discovered && seen.size >= maxNodes) { truncated = true; continue; }
			if (paths.length >= maxPaths) { return { fileBased: true, paths, truncated: true }; }
			const next = [caller, ...chain]; paths.push(next);
			if (!discovered) {
				seen.add(caller);
				if (next.length <= depth) { queue.push(next); }
			}
		}
	}
	return { fileBased: true, paths, truncated };
}
