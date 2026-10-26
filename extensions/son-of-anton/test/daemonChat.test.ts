/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { NodeSession, type NodeSessionState, type NodeSessionOptions } from '@codypendent/protocol/node';
import type { Payload, SessionSummary } from '@codypendent/protocol';
import { configureDaemonChat, DaemonChat } from '../src/daemon/DaemonChat';
import { requestDaemonText } from '../src/daemon/DaemonText';
import { ConversationActions } from '../src/chat/ConversationActions';
import type { ConversationStore } from '../src/chat/ConversationStore';

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
async function until(check: () => boolean): Promise<void> {
	for (let count = 0; count < 300; count++) { if (check()) { return; } await tick(); }
	throw new Error('Daemon adapter condition not reached.');
}
class FakeSession extends NodeSession {
	view: NodeSessionState = { status: 'ready', projection: { title: 'Shared', rows: [], activeRuns: [], approvals: [], questions: [], historyTruncated: false, runs: [] } };
	submissions: string[] = [];
	profiles: Awaited<ReturnType<NodeSession['probeModels']>> = [];
	cancelled: string[] = [];
	acceptGate?: Promise<void>;
	connectGate?: Promise<void>;
	constructor(readonly configuration: NodeSessionOptions) { super(configuration); }
	override get snapshot(): NodeSessionState { return this.view; }
	override async connect(session?: SessionSummary): Promise<void> {
		await this.connectGate; this.view = { ...this.view, sessionId: session?.session_id, status: session ? 'attached' : 'ready' }; this.changed();
	}
	override disconnect(): void { this.view.status = 'closed'; this.changed(); }
	override async probeModels(): Promise<Awaited<ReturnType<NodeSession['probeModels']>>> { return this.profiles; }
	override async submit(text: string): Promise<string> {
		this.submissions.push(text); await this.acceptGate;
		const id = randomUUID();
		this.view.projection.activeRuns = [id]; this.view.projection.runs!.push({ id, state: 'Running' }); this.changed(); return id;
	}
	override async readService(): Promise<Payload> { return { type: 'BlackboardItems', command_id: randomUUID(), items: [] }; }
	override async cancelRun(id: string): Promise<void> { this.cancelled.push(id); this.finish(id, true); }
	finish(id: string, cancelled = false): void {
		this.view.projection.activeRuns = this.view.projection.activeRuns.filter(run => run !== id);
		const run = this.view.projection.runs!.find(run => run.id === id)!;
		run.state = cancelled ? 'Cancelled' : 'Completed'; run.disposition = cancelled ? { type: 'Cancelled' } : { type: 'Completed' }; this.changed();
	}
	private changed(): void { this.configuration.onChange(this.view); }
}

suite('Primary shared chat ownership', () => {
	const mock = require('vscode') as typeof vscode;
	const links = new Map<string, { sessionId: string; repository: string; title: string }>();
	let restore: () => void;
	let configured: vscode.Disposable;
	let runtime: DaemonChat;
	let clients: FakeSession[];
	let published: Record<string, unknown>[];
	setup(() => {
		clients = []; links.clear(); published = [];
		for (const id of ['first', 'second']) links.set(`sota.daemon.session.${id}`, { sessionId: randomUUID(), repository: '/fixture/repository', title: id });
		const original = mock.workspace.getConfiguration;
		Object.assign(mock.workspace, { getConfiguration: () => ({ get: () => undefined }) });
		restore = () => Object.assign(mock.workspace, { getConfiguration: original });
		configured = configureDaemonChat({ workspaceState: { get: (key: string) => links.get(key), update: async (key: string, value: typeof links extends Map<string, infer V> ? V : never) => { links.set(key, value); } } } as unknown as vscode.ExtensionContext);
		runtime = new DaemonChat({ post: message => published.push(message), onState: () => {}, title: id => id,
			createSession: options => { const client = new FakeSession(options); clients.push(client); return client; } });
	});
	teardown(() => { runtime.dispose(); configured.dispose(); restore(); });

	test('waits for the accepted run to terminate and disconnecting never cancels it', async () => {
		let accepted = false; let settled = false;
		const result = runtime.send('first', 'Shared prompt', 'Build', 'daemon:default', 'request-1', new AbortController().signal,
			() => { accepted = true; }).then(() => { settled = true; });
		await until(() => accepted);
		assert.equal(settled, false);
		clients[0].finish(clients[0].snapshot.projection.activeRuns[0]); await result;
		runtime.dispose(); assert.deepEqual(clients[0].cancelled, []);
	});

	test('Stop before the receipt cancels that run and does not cancel the next prompt', async () => {
		await runtime.select('first'); const client = clients[0];
		let release!: () => void; client.acceptGate = new Promise<void>(resolve => { release = resolve; });
		const first = runtime.send('first', 'First', 'Build', 'daemon:default', 'request-1', new AbortController().signal, () => {});
		await until(() => client.submissions.length === 1);
		await runtime.cancel(); release(); await first;
		client.acceptGate = undefined;
		const second = runtime.send('first', 'Second', 'Build', 'daemon:default', 'request-2', new AbortController().signal, () => {});
		await until(() => client.snapshot.projection.activeRuns.length === 1);
		assert.equal(client.cancelled.length, 1);
		client.finish(client.snapshot.projection.activeRuns[0]); await second;
	});

	test('switching sessions stops observation without cancelling the daemon run', async () => {
		const result = runtime.send('first', 'Still running', 'Build', 'daemon:default', 'request-1', new AbortController().signal, () => {});
		const rejected = assert.rejects(result, /Stopped observing/);
		await until(() => clients[0]?.snapshot.projection.activeRuns.length === 1);
		await runtime.select('second'); await rejected;
		assert.deepEqual(clients.map(client => client.cancelled), [[], []]);
	});
	test('removing a shared bookmark explicitly preserves the daemon transcript', async () => {
		const original = mock.window.showWarningMessage;
		let question = ''; let removed = '';
		Object.assign(mock.window, { showWarningMessage: async (text: string, _options: object, action: string) => { question = text; return action; } });
		try {
			const actions = new ConversationActions({ load: () => ({ summary: { id: 'first', title: 'Shared work' }, messages: [] }), delete: (id: string) => { removed = id; } } as unknown as ConversationStore);
			await actions.delete('first');
			assert.match(question, /IDE bookmark/); assert.match(question, /transcript remain in Codypendent/); assert.equal(removed, 'first');
		} finally { Object.assign(mock.window, { showWarningMessage: original }); }
	});
	test('a missing or unavailable model is never advertised as a usable automatic route', async () => {
		await runtime.select('first'); const client = clients[0];
		const models = () => (published.findLast(item => item.type === 'providerCatalog') as { snapshot: { providers: Array<{ models: Array<{ chat: boolean }> }> } }).snapshot.providers[0].models;
		assert.equal(models()[0].chat, false);
		client.profiles = [{ id: 'configured', probed: false, readiness: { state: 'unavailable', detail: 'Credential missing' } }];
		await runtime.refreshModels(); assert.deepEqual(models().map(item => item.chat), [false, false]);
		client.profiles = [{ id: 'configured', probed: false, readiness: { state: 'unverified', detail: 'Not called yet' } }];
		await runtime.refreshModels(); assert.deepEqual(models().map(item => item.chat), [true, true]);
	});

});


suite('Shared inline assistance ownership', () => {
	const mock = require('vscode') as typeof vscode;
	let restore: () => void;
	let client: FakeSession;
	let internal: boolean | undefined;
	let closed: number;
	const factory = (options: NodeSessionOptions): NodeSession => {
		client = new FakeSession(options);
		client.createSession = async (_title, _workspace, _repository, request) => {
			internal = request?.internal; client.view.sessionId = randomUUID(); client.view.status = 'attached'; return client.view.sessionId;
		};
		client.closeSession = async () => { closed++; };
		return client;
	};
	setup(() => {
		const folders = mock.workspace.workspaceFolders;
		const editor = mock.window.activeTextEditor;
		Object.assign(mock.workspace, { workspaceFolders: [{ uri: { scheme: 'file', fsPath: process.cwd() } }] });
		Object.assign(mock.window, { activeTextEditor: undefined });
		client = undefined as unknown as FakeSession; internal = undefined; closed = 0;
		restore = () => { Object.assign(mock.workspace, { workspaceFolders: folders }); Object.assign(mock.window, { activeTextEditor: editor }); };
	});
	teardown(() => restore());
	test('returns complete daemon output and closes its internal session', async () => {
		const request = requestDaemonText({ model: 'daemon:default', messages: [{ role: 'user', content: 'Complete this function' }] }, factory);
		await until(() => !!client?.snapshot.projection.activeRuns.length);
		const id = client.snapshot.projection.activeRuns[0];
		client.view.projection.rows.push({ id: `${id}:reply`, kind: 'assistant', text: 'return true;' });
		client.finish(id);
		assert.equal(await request, 'return true;'); assert.equal(internal, true); assert.equal(closed, 1);
	});
	test('rejects truncated output instead of applying a partial edit', async () => {
		const request = requestDaemonText({ model: 'daemon:default', messages: [{ role: 'user', content: 'Edit this function' }] }, factory);
		const rejected = assert.rejects(request, /incomplete or too large/);
		await until(() => !!client?.snapshot.projection.activeRuns.length);
		client.view.projection.historyTruncated = true; client.finish(client.snapshot.projection.activeRuns[0]);
		await rejected; assert.equal(closed, 1);
	});
	test('cancels only its own accepted run when the editor request is aborted', async () => {
		const abort = new AbortController();
		const request = requestDaemonText({ model: 'daemon:default', messages: [{ role: 'user', content: 'Complete' }], signal: abort.signal }, factory);
		const rejected = assert.rejects(request, /cancelled/);
		await until(() => !!client?.snapshot.projection.activeRuns.length);
		const run = client.snapshot.projection.activeRuns[0]; abort.abort(); await rejected;
		assert.deepEqual(client.cancelled, [run]);
	});
});
