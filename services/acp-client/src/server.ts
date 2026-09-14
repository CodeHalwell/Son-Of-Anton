/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import http from 'node:http';
import { object } from '../_shared/acp/dist/protocol';
import { enforceHttpAuth } from '../_shared/auth/dist/index';
import { ACPClientImpl } from './client';
import { ACPDispatcher, type TaskAssignment } from './dispatcher';
import type { SessionConfig, SessionContext, SessionEvent } from './types';

/** Authenticated local service API. SSE is this HTTP facade's format, not an ACP wire transport. */
export function createServer(client: ACPClientImpl, options: { token?: string; bodyTimeoutMs?: number } = {}): http.Server {
	const dispatcher = new ACPDispatcher(client);
	const server = http.createServer((req, res) => {
		const controller = new AbortController();
		const abort = () => { if (!res.writableEnded) { controller.abort(); } };
		req.once('aborted', abort); res.once('close', abort);
		// IncomingMessage may emit ECONNRESET after its aborted notification.
		req.on('error', abort);
		void handle(req, res, controller.signal).catch(error => {
			if (res.destroyed) { return; }
			if (res.headersSent) { res.end(`event: error\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : 'ACP request failed' })}\n\n`); }
			else { json(res, error instanceof HttpError ? error.status : 400, { error: error instanceof Error ? error.message : 'ACP request failed' }); }
		}).finally(() => { req.off('aborted', abort); res.off('close', abort); });
	});
	server.requestTimeout = 30_000; server.headersTimeout = 15_000; server.keepAliveTimeout = 5_000;
	return server;

	async function handle(req: http.IncomingMessage, res: http.ServerResponse, signal: AbortSignal): Promise<void> {
		if (!enforceHttpAuth(req, res, options.token)) { return; }
		const url = new URL(req.url ?? '/', 'http://localhost');
		const segments = url.pathname.split('/').filter(Boolean);
		if (req.method === 'GET') {
			if (url.pathname === '/health') { json(res, 200, { status: 'ok', service: 'acp-client' }); return; }
			if (url.pathname === '/ready') {
				const agents = await client.listAgents();
				json(res, agents.length ? 200 : 503, { status: agents.length ? 'configured' : 'unconfigured', registeredAgents: agents.length, liveConnectivityChecked: false, runtime: client.runtime.snapshot() }); return;
			}
			if (url.pathname === '/metrics') {
				res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
				res.end(Object.entries(client.runtime.snapshot()).map(([name, value]) => `sota_acp_${name} ${value}`).join('\n') + '\n'); return;
			}
			if (url.pathname === '/agents') { json(res, 200, { agents: await client.listAgents() }); return; }
			if (url.pathname === '/sessions') { json(res, 200, { sessions: client.getActiveSessions() }); return; }
			if (url.pathname === '/permissions') { json(res, 200, { permissions: client.getPendingPermissions() }); return; }
			if (segments.length === 3 && segments[0] === 'agents' && segments[2] === 'capabilities') { json(res, 200, await client.getAgentCapabilities(decodeURIComponent(segments[1]))); return; }
		}
		if (req.method === 'DELETE' && segments.length === 2 && segments[0] === 'sessions') { await client.terminateSession(segments[1]); res.writeHead(204); res.end(); return; }
		if (req.method !== 'POST') { throw new HttpError(404, 'Not found'); }
		const body = await readBody(req, options.bodyTimeoutMs ?? 10_000);
		if (signal.aborted) { return; }
		if (url.pathname === '/sessions') { json(res, 201, await client.createSession(String(body.agentId ?? ''), body as SessionConfig)); return; }
		if (segments[0] === 'permissions' && segments.length === 2) {
			if (body.optionId !== undefined && typeof body.optionId !== 'string') { throw new HttpError(400, 'optionId must be a string'); }
			client.resolvePermission(segments[1], body.optionId); json(res, 200, { resolved: true }); return;
		}
		if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'cancel') { await client.cancelSession(segments[1]); json(res, 202, { cancelling: true }); return; }
		const streaming = body.stream === true;
		const emit = (event: SessionEvent) => {
			if (!streaming || res.destroyed) { return; }
			const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
			// Never retain an unbounded response for a stalled HTTP consumer.
			if (res.writableLength + Buffer.byteLength(frame) > 1024 * 1024) { throw new HttpError(503, 'ACP event consumer is too slow'); }
			res.write(frame);
		};
		if (url.pathname === '/dispatch') {
			if (streaming) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); }
			const result = await dispatcher.dispatchTask(body as unknown as TaskAssignment, signal, emit);
			if (streaming) { res.end(`event: result\ndata: ${JSON.stringify({ ...result, events: undefined })}\n\n`); }
			else { json(res, 200, result); }
			return;
		}
		if (segments[0] === 'sessions' && segments.length === 3 && segments[2] === 'messages') {
			const id = segments[1];
			client.onSessionEvent(id, emit);
			try {
				if (streaming) { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); }
				await client.sendMessage(id, body.message as string, body.context as SessionContext | undefined, signal);
				if (streaming) { res.end(); } else { json(res, 200, { status: client.getSessionStatus(id) }); }
			} finally { client.offSessionEvent(id, emit); }
			return;
		}
		throw new HttpError(404, 'Not found');
	}
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function json(res: http.ServerResponse, status: number, body: object): void { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
function readBody(req: http.IncomingMessage, timeoutMs: number): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []; let bytes = 0;
		const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
		const error = (cause: Error) => { cleanup(); reject(cause); req.resume(); };
		const aborted = () => error(new HttpError(400, 'Request body aborted'));
		const data = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { error(new HttpError(413, 'Request body exceeds 1 MiB')); } else { chunks.push(chunk); } };
		const end = () => {
			cleanup();
			try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(body)) { throw new Error(); } resolve(body); }
			catch { reject(new HttpError(400, 'Expected a JSON object')); }
		};
		const timer = setTimeout(() => error(new HttpError(408, 'Request body timed out')), timeoutMs);
		req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
	});
}
