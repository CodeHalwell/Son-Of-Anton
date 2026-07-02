// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

import http from 'http';
import { ContextSanitiser } from './sanitiser';
import { WorkspaceScanner } from './scanner';
import { prometheusHandler } from '../_lib/metrics/dist/index.js';
import { enforceHttpAuth, requireServiceToken } from '../_shared/auth/dist/index.js';

const PORT = parseInt(process.env.SANITISER_PORT ?? '3302', 10);
const PROJECT_PATH = process.env.PROJECT_PATH ?? '/workspace';

const sanitiser = new ContextSanitiser();
const scanner = new WorkspaceScanner();

const httpServer = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

	// Enforce inter-service auth (exempts /health and /metrics).
	if (!enforceHttpAuth(req, res)) {
		return;
	}

	// Health endpoint
	if (url.pathname === '/health') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			status: 'ok',
			service: 'context-sanitiser',
		}));
		return;
	}

	// Sanitise content
	if (url.pathname === '/sanitise' && req.method === 'POST') {
		const body = await readBody(req);
		try {
			const { content, source } = JSON.parse(body);
			const result = sanitiser.sanitise(content, source);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(result));
		} catch (err) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: (err as Error).message }));
		}
		return;
	}

	// Review MCP tool descriptions
	if (url.pathname === '/review-mcp-tools' && req.method === 'POST') {
		const body = await readBody(req);
		try {
			const { serverName, tools } = JSON.parse(body);
			const review = sanitiser.reviewMcpTools(serverName, tools);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(review));
		} catch (err) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: (err as Error).message }));
		}
		return;
	}

	// Scan workspace
	if (url.pathname === '/scan' && req.method === 'POST') {
		const body = await readBody(req);
		let includeDeps = false;
		try {
			const parsed = JSON.parse(body);
			includeDeps = parsed.includeDependencies ?? false;
		} catch {
			// Default options
		}

		try {
			const result = await scanner.scan(PROJECT_PATH, includeDeps);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(result));
		} catch (err) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: (err as Error).message }));
		}
		return;
	}

	// Get security prompt addition
	if (url.pathname === '/security-prompt' && req.method === 'GET') {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			prompt: ContextSanitiser.getSecurityPromptAddition(),
		}));
		return;
	}

	// Prometheus metrics endpoint
	if (url.pathname === '/metrics') {
		prometheusHandler()(req, res);
		return;
	}

	res.writeHead(404, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify({ error: 'Not found' }));
});

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

async function start(): Promise<void> {
	requireServiceToken('context-sanitiser');
	httpServer.listen(PORT, () => {
		console.log(`[context-sanitiser] Context sanitiser listening on port ${PORT}`);
		console.log(`[context-sanitiser] Health endpoint: http://localhost:${PORT}/health`);
		console.log(`[context-sanitiser] Metrics endpoint: http://localhost:${PORT}/metrics`);
		console.log(`[context-sanitiser] Workspace: ${PROJECT_PATH}`);
	});
}

start().catch(err => {
	console.error('[context-sanitiser] Fatal startup error:', err);
	process.exit(1);
});

export { ContextSanitiser, WorkspaceScanner };
