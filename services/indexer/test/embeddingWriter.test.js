// Son of Anton — Embedding Writer Tests
// Validates incremental embedding behaviour: content-hash vector reuse (F-2),
// stale-point cleanup, and that unchanged chunks are never dropped from Qdrant.
//
// Requires the compiled TypeScript (`npx tsc`) — the test script builds first.

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { EmbeddingWriter } = require('../dist/writers/embeddingWriter.js');

function hashOf(content) {
	return crypto.createHash('sha256').update(content).digest('hex');
}

function fn(name, body, startLine = 1) {
	return {
		kind: 'function',
		name,
		qualifiedName: name,
		startLine,
		endLine: startLine + 2,
		body,
		contentHash: hashOf(body),
	};
}

function extraction(functions) {
	return { functions, classes: [], types: [], imports: [], calls: [] };
}

class FakeQdrant {
	constructor() {
		this.points = new Map(); // id -> point
		this.log = [];
	}
	async deleteByFilePath(filePath) {
		this.log.push(['deleteByFilePath', filePath]);
		for (const [id, p] of this.points) {
			if (p.payload.filePath === filePath) {
				this.points.delete(id);
			}
		}
	}
	async deletePoints(ids) {
		this.log.push(['deletePoints', ids.length]);
		for (const id of ids) {
			this.points.delete(id);
		}
	}
	async upsertPoints(points) {
		this.log.push(['upsertPoints', points.length]);
		for (const p of points) {
			this.points.set(p.id, p);
		}
	}
}

class CountingProvider {
	constructor() {
		this.embedCalls = [];
	}
	async embed(texts) {
		this.embedCalls.push(texts);
		return texts.map(t => {
			const h = crypto.createHash('sha256').update(t).digest();
			return [h[0] / 255, h[1] / 255];
		});
	}
	dimensions() {
		return 2;
	}
	get name() {
		return 'counting';
	}
}

const config = { embedding: { batchSize: 32 } };

describe('EmbeddingWriter', () => {
	let qdrant;
	let provider;
	let writer;

	beforeEach(() => {
		qdrant = new FakeQdrant();
		provider = new CountingProvider();
		writer = new EmbeddingWriter(qdrant, provider, config);
	});

	test('first index embeds and stores every chunk', async () => {
		const count = await writer.writeFile('a.ts', 'typescript', extraction([
			fn('alpha', 'function alpha() { return 1; }', 1),
			fn('beta', 'function beta() { return 2; }', 10),
		]));

		assert.deepStrictEqual(
			{ count, stored: qdrant.points.size, embedBatches: provider.embedCalls.length },
			{ count: 2, stored: 2, embedBatches: 1 }
		);
	});

	test('editing one function keeps the other function\'s point in Qdrant', async () => {
		await writer.writeFile('a.ts', 'typescript', extraction([
			fn('alpha', 'function alpha() { return 1; }', 1),
			fn('beta', 'function beta() { return 2; }', 10),
		]));

		const count = await writer.writeFile('a.ts', 'typescript', extraction([
			fn('alpha', 'function alpha() { return 42; }', 1),
			fn('beta', 'function beta() { return 2; }', 10),
		]));

		const stored = [...qdrant.points.values()].map(p => p.payload.symbolName).sort();
		assert.deepStrictEqual(
			{ count, stored, embeddedTexts: provider.embedCalls.flat() },
			{
				count: 1,
				stored: ['alpha', 'beta'],
				embeddedTexts: [
					'function alpha() { return 1; }',
					'function beta() { return 2; }',
					'function alpha() { return 42; }',
				],
			}
		);
	});

	test('unchanged file is a no-op', async () => {
		const source = extraction([fn('alpha', 'function alpha() { return 1; }', 1)]);
		await writer.writeFile('a.ts', 'typescript', source);
		const count = await writer.writeFile('a.ts', 'typescript', source);

		assert.deepStrictEqual(
			{ count, embedBatches: provider.embedCalls.length },
			{ count: 0, embedBatches: 1 }
		);
	});

	test('renamed symbol with identical body reuses the cached vector (F-2)', async () => {
		const body = 'function whatever() { return "stable"; }';
		await writer.writeFile('a.ts', 'typescript', extraction([fn('oldName', body, 1)]));
		const vectorBefore = [...qdrant.points.values()][0].vector;

		const count = await writer.writeFile('a.ts', 'typescript', extraction([fn('newName', body, 1)]));

		const points = [...qdrant.points.values()];
		assert.deepStrictEqual(
			{
				count,
				storedNames: points.map(p => p.payload.symbolName),
				vectorReused: JSON.stringify(points[0].vector) === JSON.stringify(vectorBefore),
				embedBatches: provider.embedCalls.length,
			},
			{ count: 1, storedNames: ['newName'], vectorReused: true, embedBatches: 1 }
		);
	});

	test('moved symbol (line shift) reuses vector and cleans up the stale point', async () => {
		const body = 'function gamma() { return 3; }';
		await writer.writeFile('a.ts', 'typescript', extraction([fn('gamma', body, 5)]));

		await writer.writeFile('a.ts', 'typescript', extraction([fn('gamma', body, 25)]));

		const points = [...qdrant.points.values()];
		assert.deepStrictEqual(
			{
				stored: points.map(p => ({ name: p.payload.symbolName, line: p.payload.startLine })),
				embedBatches: provider.embedCalls.length,
				deletedStale: qdrant.log.some(([op]) => op === 'deletePoints'),
			},
			{ stored: [{ name: 'gamma', line: 25 }], embedBatches: 1, deletedStale: true }
		);
	});

	test('deleted symbol is removed from Qdrant', async () => {
		await writer.writeFile('a.ts', 'typescript', extraction([
			fn('alpha', 'function alpha() { return 1; }', 1),
			fn('beta', 'function beta() { return 2; }', 10),
		]));

		await writer.writeFile('a.ts', 'typescript', extraction([
			fn('alpha', 'function alpha() { return 1; }', 1),
		]));

		const stored = [...qdrant.points.values()].map(p => p.payload.symbolName);
		assert.deepStrictEqual(stored, ['alpha']);
	});

	test('duplicate content within a batch is embedded once', async () => {
		const body = 'function dup() { return 0; }';
		await writer.writeFile('a.ts', 'typescript', extraction([
			fn('dupA', body, 1),
			fn('dupB', body, 10),
		]));

		assert.deepStrictEqual(
			{ stored: qdrant.points.size, embeddedTexts: provider.embedCalls.flat() },
			{ stored: 2, embeddedTexts: [body] }
		);
	});
});
