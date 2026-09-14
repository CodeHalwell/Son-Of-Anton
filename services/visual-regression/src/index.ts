// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

import http from 'http';
import fs from 'fs/promises';
import path from 'path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { workspacePath, writeWorkspaceFile, WorkspacePathError } from '../_shared/auth/dist/workspaceFs.js';
import { ComparisonResult, ComparisonReport, BaselineInfo } from './types';
import { enforceHttpAuth, requireServiceToken } from '../_shared/auth/dist/index.js';

const PORT = parseInt(process.env.VISUAL_REGRESSION_PORT ?? '8094', 10);
const BASELINES_DIR = process.env.BASELINES_DIR ?? '/workspace/.son-of-anton/visual-baselines';

/**
 * Visual regression testing service.
 * Compares screenshots against stored baselines using pixel-level diffing.
 */
export class VisualRegressionService {
	private readonly baselinesDir: string;
	private readonly diffThreshold: number;

	constructor(baselinesDir: string) {
		this.baselinesDir = baselinesDir;
		this.diffThreshold = Number(process.env.DIFF_THRESHOLD ?? '0.01');
		if (!Number.isFinite(this.diffThreshold) || this.diffThreshold < 0 || this.diffThreshold > 1) {
			throw new Error('DIFF_THRESHOLD must be a number between 0 and 1');
		}
	}

	async initialize(): Promise<void> {
		await fs.mkdir(this.baselinesDir, { recursive: true });
	}

	/**
	 * Store a new baseline screenshot.
	 */
	async saveBaseline(name: string, imageData: Buffer): Promise<BaselineInfo> {
		const dir = await workspacePath(this.baselinesDir, this.validateName(name));
		const png = decodeImage(imageData);
		await fs.mkdir(dir, { recursive: true });

		const filePath = path.join(dir, 'baseline.png');
		await writeWorkspaceFile(this.baselinesDir, filePath, imageData);

		const info: BaselineInfo = {
			name,
			path: filePath,
			savedAt: Date.now(),
			width: 0,
			height: 0,
		};

		// Read dimensions
		info.width = png.width;
		info.height = png.height;

		// Save metadata
		await writeWorkspaceFile(
			this.baselinesDir, path.join(dir, 'metadata.json'),
			JSON.stringify(info, null, '\t')
		);

		return info;
	}

	/**
	 * Compare a screenshot against its baseline.
	 */
	async compare(name: string, currentImage: Buffer): Promise<ComparisonResult> {
		const dir = await workspacePath(this.baselinesDir, this.validateName(name));
		const baselinePath = await workspacePath(this.baselinesDir, path.join(dir, 'baseline.png'));

		// Check if baseline exists
		try {
			await fs.access(baselinePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
			return {
				name,
				status: 'no_baseline',
				mismatchPercentage: 0,
				mismatchPixels: 0,
				totalPixels: 0,
				diffImagePath: null,
				message: 'No baseline found. Save a baseline first.',
			};
		}

		const baselineData = await fs.readFile(baselinePath);
		const baseline = decodeImage(baselineData);
		const current = decodeImage(currentImage);
		await writeWorkspaceFile(this.baselinesDir, path.join(dir, 'current.png'), currentImage);

		// Check dimension mismatch
		if (baseline.width !== current.width || baseline.height !== current.height) {
			return {
				name,
				status: 'dimension_mismatch',
				mismatchPercentage: 100,
				mismatchPixels: 0,
				totalPixels: baseline.width * baseline.height,
				diffImagePath: null,
				message: `Dimensions differ: baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}`,
			};
		}

		// Pixel comparison
		const diff = new PNG({ width: baseline.width, height: baseline.height });
		const totalPixels = baseline.width * baseline.height;

		const mismatchPixels = pixelmatch(
			baseline.data,
			current.data,
			diff.data,
			baseline.width,
			baseline.height,
			{
				threshold: 0.1, // Anti-aliasing tolerance
				includeAA: false, // Ignore anti-aliasing differences
			}
		);

		const mismatchPercentage = (mismatchPixels / totalPixels) * 100;

		// Save diff image
		const diffPath = path.join(dir, 'diff.png');
		await writeWorkspaceFile(this.baselinesDir, diffPath, PNG.sync.write(diff));

		const passed = mismatchPercentage <= this.diffThreshold * 100;

		return {
			name,
			status: passed ? 'passed' : 'failed',
			mismatchPercentage: Math.round(mismatchPercentage * 100) / 100,
			mismatchPixels,
			totalPixels,
			diffImagePath: diffPath,
			message: passed
				? `Visual comparison passed (${mismatchPercentage.toFixed(2)}% difference)`
				: `Visual regression detected: ${mismatchPercentage.toFixed(2)}% of pixels differ`,
		};
	}

	/**
	 * Update the baseline with the current screenshot.
	 */
	async approveBaseline(name: string): Promise<boolean> {
		const dir = await workspacePath(this.baselinesDir, this.validateName(name));
		const currentPath = await workspacePath(this.baselinesDir, path.join(dir, 'current.png'));
		const baselinePath = await workspacePath(this.baselinesDir, path.join(dir, 'baseline.png'));

		try {
			const imageData = await fs.readFile(currentPath);
			const png = decodeImage(imageData);
			await writeWorkspaceFile(this.baselinesDir, baselinePath, imageData);

			// Update metadata
			const metadata: BaselineInfo = {
				name,
				path: baselinePath,
				savedAt: Date.now(),
				width: png.width,
				height: png.height,
			};
			await writeWorkspaceFile(
				this.baselinesDir, path.join(dir, 'metadata.json'),
				JSON.stringify(metadata, null, '\t')
			);

			// Clean up diff
			try {
				await fs.unlink(path.join(dir, 'diff.png')).catch(error => { if (error.code !== 'ENOENT') { throw error; } });
				await fs.unlink(currentPath);
			} catch {
				// Best effort cleanup
			}

			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Run comparison for multiple screenshots and generate a report.
	 */
	async generateReport(comparisons: ComparisonResult[]): Promise<ComparisonReport> {
		if (!Array.isArray(comparisons) || comparisons.some(c => !c || !['passed', 'failed', 'no_baseline', 'dimension_mismatch'].includes(c.status))) {
			throw new InvalidRequestError('comparisons must be an array of valid comparison results');
		}
		const passed = comparisons.filter(c => c.status === 'passed').length;
		const failed = comparisons.filter(c => c.status === 'failed').length;
		const noBaseline = comparisons.filter(c => c.status === 'no_baseline').length;
		const dimensionMismatch = comparisons.filter(c => c.status === 'dimension_mismatch').length;

		return {
			timestamp: Date.now(),
			total: comparisons.length,
			passed,
			failed,
			noBaseline,
			dimensionMismatch,
			results: comparisons,
			summary: failed + dimensionMismatch + noBaseline > 0
				? `${passed} passed; ${failed} failed; ${dimensionMismatch} dimension mismatches; ${noBaseline} missing baselines`
				: comparisons.length === 0 ? 'No comparisons were provided' : `All ${passed} comparisons passed`,
		};
	}

	/**
	 * List all stored baselines.
	 */
	async listBaselines(): Promise<BaselineInfo[]> {
		const baselines: BaselineInfo[] = [];

		try {
			const entries = await fs.readdir(this.baselinesDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					try {
						const metadataPath = await workspacePath(this.baselinesDir, path.join(entry.name, 'metadata.json'));
						const data = await fs.readFile(metadataPath, 'utf-8');
						baselines.push(JSON.parse(data));
					} catch {
						// Skip entries without metadata
					}
				}
			}
		} catch {
			// No baselines directory
		}

		return baselines;
	}

	private validateName(name: string): string {
		if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
			throw new InvalidRequestError('Name must contain 1–128 letters, numbers, underscores, or hyphens');
		}
		return name;
	}
}

class InvalidRequestError extends Error { }

function decodeImage(image: Buffer): PNG {
	if (image.length > 10 * 1024 * 1024 || image.length < 24 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		throw new InvalidRequestError('Upload must be a PNG smaller than 10 MiB');
	}
	const pixels = image.readUInt32BE(16) * image.readUInt32BE(20);
	if (pixels === 0 || pixels > 16777216) { throw new InvalidRequestError('PNG must contain between 1 and 16777216 pixels'); }
	try { return PNG.sync.read(image); } catch { throw new InvalidRequestError('Invalid PNG image'); }
}

// --- HTTP API ---
const service = new VisualRegressionService(BASELINES_DIR);

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

	// Enforce inter-service auth (exempts /health and /metrics).
	if (!enforceHttpAuth(req, res)) {
		return;
	}

	if (url.pathname === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'ok', service: 'visual-regression' }));
		return;
	}

	if (url.pathname === '/baselines' && req.method === 'GET') {
		const baselines = await service.listBaselines();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(baselines, null, 2));
		return;
	}

	if (url.pathname === '/baselines' && req.method === 'POST') {
		const { name, buffer } = await readImageRequest(req);
		const info = await service.saveBaseline(name, buffer);
		res.writeHead(201, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(info, null, 2));
		return;
	}

	if (url.pathname === '/compare' && req.method === 'POST') {
		const { name, buffer } = await readImageRequest(req);
		const result = await service.compare(name, buffer);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result, null, 2));
		return;
	}

	if (url.pathname === '/approve' && req.method === 'POST') {
		const body = await readBody(req);
		const { name } = JSON.parse(body) ?? {};
		const approved = await service.approveBaseline(name);
		res.writeHead(approved ? 200 : 400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ approved }));
		return;
	}

	if (url.pathname === '/report' && req.method === 'POST') {
		const body = await readBody(req);
		const { comparisons } = JSON.parse(body) ?? {};
		const report = await service.generateReport(comparisons);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(report, null, 2));
		return;
	}

	res.writeHead(404);
	res.end('Not found');
}

async function readImageRequest(req: http.IncomingMessage): Promise<{ name: string; buffer: Buffer }> {
	const body = JSON.parse(await readBody(req));
	if (!body || typeof body.name !== 'string' || typeof body.imageData !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.imageData)) {
		throw new InvalidRequestError('A name and base64-encoded PNG imageData are required');
	}
	const buffer = Buffer.from(body.imageData, 'base64');
	decodeImage(buffer);
	return { name: body.name, buffer };
}

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > 14 * 1024 * 1024) { chunks.length = 0; reject(new InvalidRequestError('Request exceeds 14 MiB')); return; }
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
		req.on('error', reject);
	});
}

const httpServer = http.createServer(async (req, res) => {
	try {
		await handleRequest(req, res);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		res.writeHead(err instanceof InvalidRequestError || err instanceof SyntaxError || err instanceof WorkspacePathError ? 400 : 500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: message }));
	}
});

if (require.main === module) {
	requireServiceToken('visual-regression');
	service.initialize().then(() => {
		httpServer.listen(PORT, () => {
			const address = httpServer.address();
			console.log(`[visual-regression] Listening on port ${typeof address === 'object' ? address?.port : PORT}`);
		});
	});
}
