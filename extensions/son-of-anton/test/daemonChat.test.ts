/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { NodeSession, type NodeSessionState, type NodeSessionOptions } from '@codypendent/protocol/node';
import type { Payload, QuestionOutcome, SessionSummary } from '@codypendent/protocol';
import { configureDaemonChat, DaemonChat, pickSharedConversation } from '../src/daemon/DaemonChat';
import { requestDaemonText } from '../src/daemon/DaemonText';
import { ConversationActions } from '../src/chat/ConversationActions';
import type { ConversationStore } from '../src/chat/ConversationStore';

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
interface FixtureEndpoint { socketPath: string; identity: string; mode: 'local' | 'external' }
interface FixtureSessionLink { sessionId: string; repository: string; title: string; runtimeIdentity?: string }
const localEndpoint = (): FixtureEndpoint => ({ socketPath: '/fixture/son-of-anton/daemon.sock', identity: 'son-of-anton:fixture', mode: 'local' });
async function until(check: () => boolean): Promise<void> {
	for (let count = 0; count < 300; count++) { if (check()) { return; } await tick(); }
	throw new Error('Daemon adapter condition not reached.');
}
class FakeSession extends NodeSession {
	view: NodeSessionState = { status: 'ready', projection: { title: 'Shared', rows: [], activeRuns: [], approvals: [], questions: [], historyTruncated: false, runs: [] } };
	submissions: string[] = [];
	profiles: Awaited<ReturnType<NodeSession['probeModels']>> = [];
	cancelled: string[] = [];
	approvals: Array<{ id: string; approve: boolean }> = [];
	questions: Array<{ id: string; outcome: QuestionOutcome }> = [];
	acceptGate?: Promise<void>;
	connectGate?: Promise<void>;
	connectFailure?: Error;
	connections: Array<SessionSummary | undefined> = [];
	constructor(readonly configuration: NodeSessionOptions) { super(configuration); }
	override get snapshot(): NodeSessionState { return this.view; }
	override async connect(session?: SessionSummary): Promise<void> {
		this.connections.push(session);
		await this.connectGate;
		if (this.connectFailure) { throw this.connectFailure; }
		this.view = { ...this.view, sessionId: session?.session_id, status: session ? 'attached' : 'ready' }; this.changed();
	}
	override disconnect(): void { this.view.status = 'closed'; this.changed(); }
	override async createSession(..._args: Parameters<NodeSession['createSession']>): Promise<string> {
		const id = randomUUID(); this.view = { ...this.view, sessionId: id, status: 'attached' }; this.changed(); return id;
	}
	override async probeModels(): Promise<Awaited<ReturnType<NodeSession['probeModels']>>> { return this.profiles; }
	override async submit(text: string): Promise<string> {
		this.submissions.push(text); await this.acceptGate;
		const id = randomUUID();
		this.view.projection.activeRuns = [id]; this.view.projection.runs!.push({ id, state: 'Running' }); this.changed(); return id;
	}
	override async readService(): Promise<Payload> { return { type: 'BlackboardItems', command_id: randomUUID(), items: [] }; }
	override async cancelRun(id: string): Promise<void> { this.cancelled.push(id); this.finish(id, true); }
	override async resolveApproval(id: string, approve: boolean): Promise<void> { this.approvals.push({ id, approve }); }
	override async resolveQuestion(id: string, outcome: QuestionOutcome): Promise<void> { this.questions.push({ id, outcome }); }
	finish(id: string, cancelled = false): void {
		this.view.projection.activeRuns = this.view.projection.activeRuns.filter(run => run !== id);
		const run = this.view.projection.runs!.find(run => run.id === id)!;
		run.state = cancelled ? 'Cancelled' : 'Completed'; run.disposition = cancelled ? { type: 'Cancelled' } : { type: 'Completed' }; this.changed();
	}
	private changed(): void { this.configuration.onChange(this.view); }
}

suite('Primary shared chat ownership', () => {
	const mock = require('vscode') as typeof vscode;
	const links = new Map<string, FixtureSessionLink>();
	const reverseLinks = new Map<string, string>();
	let restore: () => void;
	let configured: vscode.Disposable;
	let runtime: DaemonChat;
	let clients: FakeSession[];
	let published: Record<string, unknown>[];
	let endpoint: FixtureEndpoint;
	let ensured: FixtureEndpoint[];
	let connectFailure: Error | undefined;
	let configurationListeners: Set<(event: vscode.ConfigurationChangeEvent) => void>;
	const changeConfiguration = (setting: string): void => {
		for (const listener of configurationListeners) { listener({ affectsConfiguration: section => section === setting }); }
	};
	setup(() => {
		clients = []; links.clear(); reverseLinks.clear(); published = []; endpoint = localEndpoint(); ensured = []; connectFailure = undefined;
		configurationListeners = new Set();
		for (const id of ['first', 'second']) { links.set(`sota.daemon.session.${id}`, { sessionId: randomUUID(), repository: '/fixture/repository', title: id, runtimeIdentity: endpoint.identity }); }
		const original = { configuration: mock.workspace.getConfiguration, changed: mock.workspace.onDidChangeConfiguration, command: mock.commands.executeCommand };
		Object.assign(mock.workspace, {
			getConfiguration: () => ({ get: () => undefined }),
			onDidChangeConfiguration: (listener: (event: vscode.ConfigurationChangeEvent) => void) => {
				configurationListeners.add(listener); return { dispose: () => { configurationListeners.delete(listener); } };
			},
		});
		Object.assign(mock.commands, { executeCommand: async (command: string, expected?: FixtureEndpoint) => {
			if (command === 'sota.daemon.endpoint') { return { ...endpoint }; }
			assert.equal(command, 'sota.daemon.ensure'); assert.deepEqual(expected, endpoint); ensured.push({ ...endpoint }); return undefined;
		} });
		restore = () => { Object.assign(mock.workspace, { getConfiguration: original.configuration, onDidChangeConfiguration: original.changed }); Object.assign(mock.commands, { executeCommand: original.command }); };
		configured = configureDaemonChat({ workspaceState: { get: (key: string) => links.get(key) ?? reverseLinks.get(key), update: async (key: string, value: FixtureSessionLink | string) => {
			if (typeof value === 'string') { reverseLinks.set(key, value); } else { links.set(key, value); }
		} } } as unknown as vscode.ExtensionContext);
		runtime = new DaemonChat({ post: message => published.push(message), onState: () => {}, title: id => id,
			createSession: options => { const client = new FakeSession(options); client.connectFailure = connectFailure; clients.push(client); return client; } });
	});
	teardown(() => { runtime.dispose(); configured.dispose(); restore(); });

	test('local runtime refuses an unscoped legacy bookmark before opening a client', async () => {
		const saved = links.get('sota.daemon.session.first')!; delete saved.runtimeIdentity;
		const before = structuredClone(saved);
		await assert.rejects(runtime.select('first'), /runtime|endpoint|legacy|Codypendent/i);
		assert.deepEqual({ clients: clients.length, ensured, saved: links.get('sota.daemon.session.first') }, { clients: 0, ensured: [], saved: before });
	});

	test('a foreign runtime identity is refused in local and explicit external modes', async () => {
		const saved = links.get('sota.daemon.session.first')!; saved.runtimeIdentity = 'another-runtime';
		const before = structuredClone(saved);
		for (const mode of ['local', 'external'] as const) {
			endpoint = { ...endpoint, mode };
			await assert.rejects(runtime.select('first'), /runtime|endpoint/i);
		}
		assert.deepEqual({ clients: clients.length, ensured, saved: links.get('sota.daemon.session.first') }, { clients: 0, ensured: [], saved: before });
	});

	test('explicit external mode scopes a legacy bookmark only after attaching its existing session', async () => {
		const saved = links.get('sota.daemon.session.first')!; delete saved.runtimeIdentity;
		const before = structuredClone(saved);
		endpoint = { socketPath: '/fixture/external/daemon.sock', identity: 'external:fixture', mode: 'external' };
		await runtime.select('first');
		assert.deepEqual({ socket: clients[0].configuration.socketPath, attached: clients[0].connections[0]?.session_id, saved: links.get('sota.daemon.session.first'), ensured }, {
			socket: endpoint.socketPath, attached: before.sessionId, saved: { ...before, runtimeIdentity: endpoint.identity }, ensured: [endpoint],
		});
	});

	test('a failed external attachment leaves its legacy bookmark unchanged', async () => {
		const saved = links.get('sota.daemon.session.first')!; delete saved.runtimeIdentity;
		const before = structuredClone(saved);
		endpoint = { socketPath: '/fixture/external/daemon.sock', identity: 'external:fixture', mode: 'external' };
		connectFailure = new Error('Fixture attachment failed');
		await assert.rejects(runtime.select('first'), /Fixture attachment failed/);
		assert.deepEqual(links.get('sota.daemon.session.first'), before);
	});

	test('changing the endpoint rechecks a previously cached conversation connection', async () => {
		await runtime.select('first');
		const before = structuredClone(links.get('sota.daemon.session.first'));
		endpoint = { ...endpoint, socketPath: '/fixture/another/daemon.sock', identity: 'son-of-anton:another' };
		await assert.rejects(runtime.select('first'), /runtime|endpoint/i);
		assert.deepEqual({ clients: clients.length, ensures: ensured.length, submissions: clients[0].submissions, saved: links.get('sota.daemon.session.first') }, {
			clients: 1, ensures: 1, submissions: [], saved: before,
		});
		assert.equal(runtime.snapshot, undefined);
	});

	for (const setting of ['sota.daemon.connection', 'sota.daemon.socketPath', 'sota.runtime.backend']) {
		test(`${setting} immediately revokes pending controls without cancelling the old runtime`, async () => {
			await runtime.select('first'); const client = clients[0];
			await client.submit('Owned by the original runtime');
			const saved = structuredClone(links.get('sota.daemon.session.first'));
			endpoint = { socketPath: '/fixture/external/daemon.sock', identity: 'external:fixture', mode: 'external' };
			changeConfiguration(setting);
			await assert.rejects(runtime.approve('pending-approval', true), /Reconnect/);
			await assert.rejects(runtime.answer('pending-question', { type: 'Rejected' }), /Reconnect/);
			await runtime.cancel();
			assert.deepEqual({ snapshot: runtime.snapshot, canWrite: client.configuration.canWrite(), approvals: client.approvals,
				questions: client.questions, cancelled: client.cancelled, clients: clients.length, saved: links.get('sota.daemon.session.first') }, {
				snapshot: undefined, canWrite: false, approvals: [], questions: [], cancelled: [], clients: 1, saved,
			});
			assert.equal(published.findLast(message => message.type === 'daemonSnapshot')?.canWrite, false);
		});
	}

	test('queued controls cannot write after an endpoint switch, even if their lookup returns the old endpoint', async () => {
		await runtime.select('first'); const client = clients[0];
		await client.submit('Keep running');
		const oldEndpoint = endpoint;
		let release!: (value: FixtureEndpoint) => void;
		const delayed = new Promise<FixtureEndpoint>(resolve => { release = resolve; });
		const execute = mock.commands.executeCommand;
		Object.assign(mock.commands, { executeCommand: (command: string, expected?: FixtureEndpoint) => command === 'sota.daemon.endpoint' ? delayed : execute(command, expected) });
		const actions = [runtime.approve('approval', true), runtime.answer('question', { type: 'Rejected' }), runtime.cancel()];
		const rejected = actions.map(action => assert.rejects(action, /superseded/i));
		endpoint = { socketPath: '/fixture/external/daemon.sock', identity: 'external:fixture', mode: 'external' };
		changeConfiguration('sota.daemon.connection'); release(oldEndpoint);
		await Promise.all(rejected);
		assert.deepEqual({ approvals: client.approvals, questions: client.questions, cancelled: client.cancelled }, { approvals: [], questions: [], cancelled: [] });
	});

	test('an endpoint mismatch rejects controls even before a configuration notification arrives', async () => {
		await runtime.select('first'); const client = clients[0];
		endpoint = { ...endpoint, socketPath: '/fixture/changed/daemon.sock' };
		await assert.rejects(runtime.approve('approval', true), /connection changed/i);
		assert.deepEqual({ snapshot: runtime.snapshot, approvals: client.approvals, canWrite: client.configuration.canWrite() }, { snapshot: undefined, approvals: [], canWrite: false });
	});

	test('pending controls still resolve on their unchanged runtime', async () => {
		await runtime.select('first'); const client = clients[0];
		await runtime.approve('approval', true);
		await runtime.answer('question', { type: 'Answered', answers: [['Selected option']] });
		assert.deepEqual({ approvals: client.approvals, questions: client.questions, canWrite: client.configuration.canWrite() }, {
			approvals: [{ id: 'approval', approve: true }], questions: [{ id: 'question', outcome: { type: 'Answered', answers: [['Selected option']] } }], canWrite: true,
		});
	});

	test('a stale control lookup cannot invalidate a newly selected connection', async () => {
		await runtime.select('first');
		const oldEndpoint = endpoint;
		const execute = mock.commands.executeCommand;
		let release!: (value: FixtureEndpoint) => void;
		const delayed = new Promise<FixtureEndpoint>(resolve => { release = resolve; });
		let lookups = 0;
		Object.assign(mock.commands, { executeCommand: (command: string, expected?: FixtureEndpoint) => {
			if (command === 'sota.daemon.endpoint' && ++lookups === 1) { return delayed; }
			return execute(command, expected);
		} });
		const rejected = assert.rejects(runtime.answer('question', { type: 'Rejected' }), /superseded/i);
		endpoint = { socketPath: '/fixture/external/daemon.sock', identity: 'external:fixture', mode: 'external' };
		changeConfiguration('sota.daemon.connection');
		links.get('sota.daemon.session.second')!.runtimeIdentity = endpoint.identity;
		await runtime.select('second'); release(oldEndpoint); await rejected;
		assert.deepEqual({ session: runtime.sessionId, canWrite: clients.map(client => client.configuration.canWrite()), questions: clients.map(client => client.questions) }, {
			session: links.get('sota.daemon.session.second')!.sessionId, canWrite: [false, true], questions: [[], []],
		});
	});

	test('switching runtimes during model discovery prevents a subsequent submission', async () => {
		await runtime.select('first'); const client = clients[0];
		let release!: (value: typeof client.profiles) => void;
		const delayed = new Promise<typeof client.profiles>(resolve => { release = resolve; });
		let probing = false;
		client.probeModels = () => { probing = true; return delayed; };
		let accepted = false;
		const rejected = assert.rejects(runtime.send('first', 'Keep this draft', 'Build', 'daemon:selected', 'request', new AbortController().signal,
			() => { accepted = true; }), /superseded/i);
		await until(() => probing);
		endpoint = { socketPath: '/fixture/external/daemon.sock', identity: 'external:fixture', mode: 'external' };
		changeConfiguration('sota.daemon.connection');
		release([{ id: 'selected', probed: false, readiness: { state: 'unverified', detail: 'Not called yet' } }]); await rejected;
		assert.deepEqual({ submissions: client.submissions, accepted }, { submissions: [], accepted: false });
	});

	for (const timing of ['before-receipt', 'on-acceptance']) {
		test(`a runtime switch ${timing} prevents late Stop compensation on the former runtime`, async () => {
			await runtime.select('first'); const client = clients[0];
			let release!: () => void; client.acceptGate = new Promise<void>(resolve => { release = resolve; });
			let accepted = false;
			const switchRuntime = (): void => {
				endpoint = { socketPath: '/fixture/external/daemon.sock', identity: 'external:fixture', mode: 'external' };
				changeConfiguration('sota.daemon.connection');
			};
			const rejected = assert.rejects(runtime.send('first', 'Original prompt', 'Build', 'daemon:default', 'request', new AbortController().signal,
				() => { accepted = true; if (timing === 'on-acceptance') { switchRuntime(); } }), /superseded/i);
			await until(() => client.submissions.length === 1);
			await runtime.cancel();
			if (timing === 'before-receipt') { switchRuntime(); }
			release(); await rejected;
			assert.deepEqual({ accepted, cancelled: client.cancelled, active: client.snapshot.projection.activeRuns.length }, {
				accepted: timing === 'on-acceptance', cancelled: [], active: 1,
			});
		});
	}

	test('an in-flight approval receipt cannot report success after its connection was invalidated', async () => {
		await runtime.select('first'); const client = clients[0];
		let release!: () => void;
		const delayed = new Promise<void>(resolve => { release = resolve; });
		client.resolveApproval = async (id, approve) => { client.approvals.push({ id, approve }); await delayed; };
		const rejected = assert.rejects(runtime.approve('approval', true), /superseded/i);
		await until(() => client.approvals.length === 1);
		changeConfiguration('sota.daemon.connection'); release(); await rejected;
		assert.deepEqual({ approvals: client.approvals, canWrite: client.configuration.canWrite(), clients: clients.length }, {
			approvals: [{ id: 'approval', approve: true }], canWrite: false, clients: 1,
		});
	});

	test('unrelated configuration preserves the connection and disposal removes its listener', async () => {
		await runtime.select('first'); const snapshot = runtime.snapshot;
		changeConfiguration('editor.fontSize');
		assert.equal(runtime.snapshot, snapshot);
		runtime.dispose(); const messages = published.length;
		changeConfiguration('sota.daemon.connection');
		assert.deepEqual({ listeners: configurationListeners.size, messages: published.length, canWrite: clients[0].configuration.canWrite() }, { listeners: 0, messages, canWrite: false });
	});

	test('a delayed endpoint lookup cannot replace a newer conversation selection', async () => {
		const execute = mock.commands.executeCommand;
		let resolveEndpoint!: (value: FixtureEndpoint) => void;
		const delayed = new Promise<FixtureEndpoint>(resolve => { resolveEndpoint = resolve; });
		let lookups = 0;
		Object.assign(mock.commands, { executeCommand: async (command: string, expected?: FixtureEndpoint) => {
			if (command === 'sota.daemon.endpoint' && ++lookups === 1) { return delayed; }
			return execute(command, expected);
		} });
		const previous = runtime.select('first');
		const rejected = assert.rejects(previous, /superseded/i);
		await runtime.select('second');
		resolveEndpoint(endpoint); await rejected;
		assert.deepEqual({ clients: clients.length, attached: runtime.sessionId, ensured }, { clients: 1, attached: links.get('sota.daemon.session.second')!.sessionId, ensured: [endpoint] });
	});

	test('a new conversation persists the identity of the runtime that created it', async () => {
		const folders = mock.workspace.workspaceFolders;
		Object.assign(mock.workspace, { workspaceFolders: [{ uri: { scheme: 'file', fsPath: (process as NodeJS.Process).cwd() } }] });
		try {
			const sent = runtime.send('new', 'New Son work', 'Build', 'daemon:default', 'new-request', new AbortController().signal, () => {});
			await until(() => !!clients[0]?.snapshot.projection.activeRuns.length);
			const sessionId = clients[0].snapshot.sessionId;
			clients[0].finish(clients[0].snapshot.projection.activeRuns[0]); await sent;
			assert.deepEqual({ sessionId: links.get('sota.daemon.session.new')?.sessionId, runtimeIdentity: links.get('sota.daemon.session.new')?.runtimeIdentity, socket: clients[0].configuration.socketPath }, {
				sessionId, runtimeIdentity: endpoint.identity, socket: endpoint.socketPath,
			});
		} finally { Object.assign(mock.workspace, { workspaceFolders: folders }); }
	});

	test('session library lookup preserves old bookmarks and reuses only the matching endpoint link', async () => {
		const sessionId = randomUUID();
		const oldLink = { sessionId, repository: '/fixture/repository', title: 'Previous runtime' };
		links.set('sota.daemon.session.legacy-bookmark', oldLink);
		reverseLinks.set(`sota.daemon.conversation.${sessionId}`, 'legacy-bookmark');
		reverseLinks.set(`sota.daemon.conversation.${endpoint.identity}.${sessionId}`, 'legacy-bookmark');
		const previous = { connect: NodeSession.prototype.connect, disconnect: NodeSession.prototype.disconnect, list: NodeSession.prototype.listSessions, pick: mock.window.showQuickPick };
		const selected: SessionSummary = { session_id: sessionId, title: 'Son work', repository: '/fixture/repository', state: 'active', created_at: '', updated_at: '' };
		const records = new Map([['legacy-bookmark', { summary: { id: 'legacy-bookmark', title: 'Previous runtime' }, messages: [] }]]);
		let created = 0;
		const store = {
			load: (id: string) => records.get(id),
			create: () => { created++; const record = { summary: { id: 'son-bookmark', title: '' }, messages: [] }; records.set(record.summary.id, record); return record; },
			rename: (id: string, title: string) => { records.get(id)!.summary.title = title; },
		} as unknown as ConversationStore;
		Object.assign(NodeSession.prototype, { connect: async () => {}, disconnect: () => {}, listSessions: async () => [selected] });
		Object.assign(mock.window, { showQuickPick: async (items: Array<{ session: SessionSummary }>) => items[0] });
		try {
			const first = await pickSharedConversation(store);
			const second = await pickSharedConversation(store);
			assert.deepEqual({ first, second, created, legacy: links.get('sota.daemon.session.legacy-bookmark'), current: links.get('sota.daemon.session.son-bookmark'), reverse: reverseLinks.get(`sota.daemon.conversation.${endpoint.identity}.${sessionId}`), unscoped: reverseLinks.get(`sota.daemon.conversation.${sessionId}`) }, {
				first: 'son-bookmark', second: 'son-bookmark', created: 1, legacy: oldLink,
				current: { sessionId, repository: selected.repository, title: selected.title, runtimeIdentity: endpoint.identity }, reverse: 'son-bookmark', unscoped: 'legacy-bookmark',
			});
		} finally {
			Object.assign(NodeSession.prototype, { connect: previous.connect, disconnect: previous.disconnect, listSessions: previous.list });
			Object.assign(mock.window, { showQuickPick: previous.pick });
		}
	});

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
		delete links.get('sota.daemon.session.first')!.runtimeIdentity;
		const original = mock.window.showWarningMessage;
		let question = ''; let removed = '';
		Object.assign(mock.window, { showWarningMessage: async (text: string, _options: object, action: string) => { question = text; return action; } });
		try {
			const actions = new ConversationActions({ load: () => ({ summary: { id: 'first', title: 'Shared work' }, messages: [] }), delete: (id: string) => { removed = id; } } as unknown as ConversationStore);
			await actions.delete('first');
			assert.match(question, /IDE bookmark/); assert.match(question, /transcript.*remain/i); assert.equal(removed, 'first');
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
		const command = mock.commands.executeCommand;
		const endpoint = localEndpoint();
		Object.assign(mock.workspace, { workspaceFolders: [{ uri: { scheme: 'file', fsPath: (process as NodeJS.Process).cwd() } }] });
		Object.assign(mock.window, { activeTextEditor: undefined });
		Object.assign(mock.commands, { executeCommand: async (name: string, expected?: FixtureEndpoint) => {
			if (name === 'sota.daemon.endpoint') { return endpoint; }
			assert.equal(name, 'sota.daemon.ensure'); assert.deepEqual(expected, endpoint); return undefined;
		} });
		client = undefined as unknown as FakeSession; internal = undefined; closed = 0;
		restore = () => { Object.assign(mock.workspace, { workspaceFolders: folders }); Object.assign(mock.window, { activeTextEditor: editor }); Object.assign(mock.commands, { executeCommand: command }); };
	});
	teardown(() => restore());
	test('returns complete daemon output and closes its internal session', async () => {
		const request = requestDaemonText({ model: 'daemon:default', messages: [{ role: 'user', content: 'Complete this function' }] }, factory);
		await until(() => !!client?.snapshot.projection.activeRuns.length);
		const id = client.snapshot.projection.activeRuns[0];
		client.view.projection.rows.push({ id: `${id}:reply`, kind: 'assistant', text: 'return true;' });
		client.finish(id);
		assert.equal(await request, 'return true;'); assert.equal(internal, true); assert.equal(closed, 1);
		assert.equal(client.configuration.socketPath, localEndpoint().socketPath);
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
