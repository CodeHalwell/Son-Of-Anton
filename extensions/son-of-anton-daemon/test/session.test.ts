/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
	encodeEnvelope, FrameDecoder, PROTOCOL_V1, type CommandBody, type Payload,
	type SessionEvent, type SessionSummary
} from '@codypendent/protocol';
import { SharedSession } from '../src/session.js';
import { projectSession } from '../src/projection.js';
import { parseViewMessage } from '../src/messages.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) { await close(); } });
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
	for (let count = 0; count < 200; count++) { if (check()) { return; } await new Promise(resolve => setTimeout(resolve, 5)); }
	throw new Error('Condition was not reached.');
}

/** Protocol fixture only: it deliberately contains no model provider or tool executor. */
async function daemonFixture(snapshotOnAttach = false) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'anton-shared-'));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const socketPath = path.join(directory, 'daemon.sock');
	const session: SessionSummary = {
		session_id: randomUUID(), title: 'From Codypendent', repository: '/fixture/repo',
		state: 'active', created_at: '', updated_at: ''
	};
	const received: CommandBody[] = [];
	const ledger: SessionEvent[] = [];
	const attached = new Set<net.Socket>();
	const sockets = new Set<net.Socket>();
	const send = (socket: net.Socket, payload: Payload, correlation?: string, sessionId?: string): void => {
		socket.write(encodeEnvelope({
			protocol_version: PROTOCOL_V1, client_id: randomUUID(), message_id: randomUUID(),
			payload, correlation_id: correlation, session_id: sessionId
		}));
	};
	const emit = (body: SessionEvent['body']): void => {
		const event: SessionEvent = { sequence: ledger.length + 1, occurred_at: new Date().toISOString(), actor: { type: 'System' }, body };
		ledger.push(event);
		for (const socket of attached) { send(socket, { type: 'Event', ...event }); }
	};
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('close', () => { attached.delete(socket); sockets.delete(socket); });
		const decoder = new FrameDecoder();
		socket.on('data', chunk => {
			for (const envelope of decoder.push(chunk)) {
				if (envelope.payload.type === 'ClientHello') {
					send(socket, {
						type: 'ServerHello', selected_protocol: PROTOCOL_V1, daemon_instance: randomUUID(),
						daemon_version: 'fixture', build_id: 'fixture', heartbeat_interval_ms: 15000
					}, envelope.message_id);
				} else if (envelope.payload.type === 'Command') {
					const body = envelope.payload.body;
					received.push(body);
					if (body.type === 'AttachSession') {
						attached.add(socket);
						const after = body.last_seen_sequence ?? 0;
						send(socket, {
							type: 'Catchup', catchup: snapshotOnAttach
								? {
									type: 'Snapshot', through: ledger.length, projection: {
										session_id: session.session_id,
										title: session.title, last_sequence: ledger.length, closed: false
									}
								}
								: { type: 'Events', from: after + 1, through: ledger.length, events: ledger.filter(event => event.sequence > after) }
						});
					} else if (body.type === 'SearchSessions') {
						send(socket, {
							type: 'SessionSearchResults', command_id: envelope.payload.command_id, page: {
								items: [{
									session,
									deep_link: { type: 'Session', session_id: session.session_id }, scope: { type: 'Session' }, score: 1,
									source: { type: 'Title' }, stable_identity: session.session_id
								}]
							}
						}, envelope.message_id);
					} else if (body.type === 'ReadSessionHistory') {
						send(socket, {
							type: 'SessionHistory', command_id: envelope.payload.command_id,
							session_id: session.session_id, page: { items: ledger }
						}, envelope.message_id);
					} else {
						send(socket, { type: 'CommandAccepted', command_id: envelope.payload.command_id }, envelope.message_id,
							body.type === 'CreateSession' ? session.session_id : undefined);
						if (body.type === 'StartRun') { emit({ type: 'RunStarted', run_id: randomUUID(), objective: body.objective, mode: body.mode }); }
					}
				}
			}
		});
	});
	await new Promise<void>(resolve => server.listen(socketPath, resolve));
	cleanup.push(() => new Promise<void>(resolve => { for (const socket of sockets) { socket.destroy(); } server.close(() => resolve()); }));
	const client = (trusted = true): SharedSession => {
		const connection = new SharedSession({ socketPath, canWrite: () => trusted, onChange: () => { }, onError: () => { }, timeoutMs: 1000 });
		cleanup.push(() => connection.disconnect()); return connection;
	};
	return { session, received, emit, client, attached, ledger };
}

describe('shared sessions across clients', () => {
	it('restores pending questions that a snapshot projection does not carry', async () => {
		const daemon = await daemonFixture(true); const anton = daemon.client();
		const id = randomUUID();
		daemon.emit({
			type: 'QuestionAsked', question_id: id, run_id: randomUUID(), questions: [
				{ header: 'Scope', question: 'Which file?', options: [{ label: 'a.ts' }], multiple: false, custom: true },
			]
		});
		await anton.connect(daemon.session);
		expect(anton.snapshot.projection.questions[0].id).toBe(id);
		await anton.resolveQuestion(id, { type: 'Answered', answers: [['a.ts']] });
		expect(daemon.received.at(-1)).toMatchObject({ type: 'ResolveQuestion', question_id: id });
	});
	it('discovers sessions, attaches two clients, and leaves a run alive when one disconnects', async () => {
		const daemon = await daemonFixture();
		const anton = daemon.client(); const desktop = daemon.client();
		await anton.connect();
		expect((await anton.listSessions())[0].session_id).toBe(daemon.session.session_id);
		await Promise.all([anton.connect(daemon.session), desktop.connect(daemon.session)]);
		await anton.submit('Explain the graph', 'Ask');
		await until(() => desktop.snapshot.projection.activeRuns.length === 1);
		const run = desktop.snapshot.projection.activeRuns[0];
		anton.disconnect();
		await until(() => daemon.attached.size === 1);
		daemon.emit({ type: 'ModelStreamDelta', run_id: run, text: 'A shared response.' });
		await until(() => desktop.snapshot.projection.rows.some(row => row.text === 'A shared response.'));
		expect(daemon.received.some(command => command.type === 'CancelRun')).toBe(false);
		await anton.connect(daemon.session);
		expect(anton.snapshot.projection.rows.some(row => row.text === 'A shared response.')).toBe(true);
	});

	it('creates a daemon-owned session using its envelope id and preserves the selected repository', async () => {
		const daemon = await daemonFixture(); const anton = daemon.client();
		await anton.connect();
		expect(await anton.createSession('Anton', randomUUID(), '/fixture/selected')).toBe(daemon.session.session_id);
		await anton.submit('Plan a change', 'Plan');
		expect(daemon.received.find(command => command.type === 'StartRun')).toMatchObject({ repository: '/fixture/selected', mode: { type: 'Plan' } });
	});

	it('relays only a currently pending approval, scoped to one action', async () => {
		const daemon = await daemonFixture(); const anton = daemon.client();
		await anton.connect(daemon.session);
		const id = randomUUID();
		daemon.emit({ type: 'ApprovalRequested', approval_id: id, action: { type: 'ReadFiles', paths: ['a.ts'] }, risk: { level: { type: 'Low' } } });
		await until(() => anton.snapshot.projection.approvals.length === 1);
		await anton.resolveApproval(id, true);
		expect(daemon.received.at(-1)).toEqual({ type: 'ResolveApproval', approval_id: id, decision: { type: 'Approve' }, scope: { type: 'Once' } });
		daemon.emit({ type: 'ApprovalResolved', approval_id: id, decision: { type: 'Approve' } });
		await until(() => anton.snapshot.projection.approvals.length === 0);
		await expect(anton.resolveApproval(id, true)).rejects.toThrow('no longer pending');
	});

	it('observes an untrusted workspace without granting it write or approval authority', async () => {
		const daemon = await daemonFixture(); const anton = daemon.client(false);
		await anton.connect(daemon.session);
		expect(daemon.received.at(-1)).toMatchObject({ type: 'AttachSession', requested_role: { type: 'Observer' } });
		await expect(anton.submit('write code', 'Build')).rejects.toThrow('Trust this workspace');
		await expect(anton.createSession('x', randomUUID(), '/fixture/repo')).rejects.toThrow('Trust this workspace');
		await expect(anton.resolveApproval(randomUUID(), true)).rejects.toThrow('Trust this workspace');
		await expect(anton.cancelRun(randomUUID())).rejects.toThrow('Trust this workspace');
	});

	it('routes follow-up prompts through the existing session and rejects unknown modes', async () => {
		const daemon = await daemonFixture(); const anton = daemon.client();
		await anton.connect({ ...daemon.session, last_run_id: randomUUID() });
		await anton.submit('Continue', 'Build');
		expect(daemon.received.at(-1)).toMatchObject({ type: 'SubmitUserInput', session_id: daemon.session.session_id, text: 'Continue' });
		await expect(anton.submit('x', 'Unknown')).rejects.toThrow('supported mode');
		await tick();
	});
});

describe('display and webview boundaries', () => {
	it('keeps unresolved work while old transcript events are evicted', () => {
		const approval = randomUUID();
		const snapshot = {
			ready: true, cursor: 1, droppedEvents: 0, events: [{
				sequence: 1, occurred_at: '', actor: { type: 'System' as const },
				body: { type: 'ApprovalRequested' as const, approval_id: approval, action: { type: 'ReadFiles' as const, paths: [] }, risk: { level: { type: 'Low' as const } } }
			}]
		};
		const first = projectSession(snapshot);
		const later = projectSession({ ready: true, cursor: 3000, droppedEvents: 1000, events: [] }, first);
		expect(later.approvals[0].id).toBe(approval);
		expect(later.historyTruncated).toBe(true);
	});

	it('treats model text as text and bounds rendered history', () => {
		const run = randomUUID();
		const projection = projectSession({
			ready: true, cursor: 2, droppedEvents: 0, events: [
				{ sequence: 1, occurred_at: '', actor: { type: 'System' }, body: { type: 'ModelStreamDelta', run_id: run, text: '<script>bad()</script>' } },
				{ sequence: 2, occurred_at: '', actor: { type: 'System' }, body: { type: 'ModelStreamDelta', run_id: run, text: ' continued' } },
			]
		});
		expect(projection.rows[0].text).toBe('<script>bad()</script> continued');
	});

	it('rejects arbitrary commands, oversized prompts and invalid session identities', () => {
		expect(parseViewMessage({ type: 'ExecuteCommand', program: 'sh' })).toBeUndefined();
		expect(parseViewMessage({ type: 'approve', sessionId: 'wrong', id: randomUUID() })).toBeUndefined();
		expect(parseViewMessage({ type: 'submit', sessionId: randomUUID(), mode: 'Build', requestId: '1', text: 'x'.repeat(100001) })).toBeUndefined();
	});
});
