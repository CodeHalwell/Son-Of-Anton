/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { SharedSession } from '../src/session.js';

const binary = process.env.CODYPENDENT_TEST_BINARY;

/** Actual Rust daemon + real Unix sockets; the model is a deterministic local HTTP fixture. */
it.skipIf(!binary)('retains a real daemon run across client disconnect and replays it to a fresh client', async () => {
	const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'anton-daemon-')));
	const data = path.join(directory, 'data'); const repository = path.join(directory, 'repo');
	await Promise.all([mkdir(data), mkdir(repository)]);
	await writeFile(path.join(repository, 'example.ts'), 'export function shared() { return true; }\n');
	execFileSync('git', ['init', '-q'], { cwd: repository });
	let releaseModel: (() => void) | undefined;
	let requested = false;
	const server = http.createServer(async (request, response) => {
		if (request.url?.endsWith('/models')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'shared-fixture' }] })); return; }
		for await (const _chunk of request) { /* consume the local fixture request */ }
		requested = true;
		await new Promise<void>(resolve => { releaseModel = resolve; });
		response.writeHead(200, { 'Content-Type': 'text/event-stream' });
		response.end('data: ' + JSON.stringify({
			id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'shared-fixture',
			choices: [{ index: 0, delta: { role: 'assistant', content: 'Shared runtime verified.' }, finish_reason: null }]
		}) + '\n\n'
			+ 'data: ' + JSON.stringify({
				id: 'fixture', object: 'chat.completion.chunk', created: 0, model: 'shared-fixture',
				choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
			})
			+ '\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') { throw new Error('No fixture address.'); }
	await writeFile(path.join(data, 'models.toml'), `[[model]]\nid = "hosted-default"\nprovider = "openai-compatible"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nmodel = "shared-fixture"\napi_key_env = ""\n`);
	const socketPath = path.join(directory, 'daemon.sock');
	const daemon = spawn(binary!, ['__daemon'], {
		cwd: repository, env: {
			...process.env,
			CODYPENDENT_DATA_DIR: data, CODYPENDENT_SOCKET: socketPath, RUST_LOG: 'warn'
		}, stdio: ['ignore', 'ignore', 'pipe']
	});
	let logs = '';
	daemon.stderr.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
	const makeClient = (): SharedSession => new SharedSession({
		socketPath, canWrite: () => true,
		onChange: () => { }, onError: () => { }, timeoutMs: 10000
	});
	const anton = makeClient(); const observer = makeClient(); const reopened = makeClient();
	let terminal: ReturnType<typeof spawn> | undefined;
	let terminalText = '';
	const openTerminal = (): void => {
		terminalText = '';
		terminal = spawn('python3', [fileURLToPath(new URL('./pty-client.py', import.meta.url)), binary!], {
			cwd: repository, env: { ...process.env, CODYPENDENT_DATA_DIR: data, CODYPENDENT_SOCKET: socketPath }, stdio: ['pipe', 'pipe', 'pipe'],
		});
		terminal.stdout!.on('data', chunk => { terminalText = (terminalText + chunk.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')).slice(-500_000); });
		terminal.stderr!.on('data', chunk => { logs = (logs + chunk.toString()).slice(-4000); });
	};
	const closeTerminal = async (): Promise<void> => {
		if (!terminal) { return; }
		const child = terminal; terminal = undefined;
		const exited = new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode !== null) { resolve(); } else { child.once('exit', () => resolve()); } });
		child.stdin!.end(); await exited;
	};
	const until = async (check: () => boolean): Promise<void> => {
		for (let count = 0; count < 400; count++) { if (check()) { return; } await new Promise(resolve => setTimeout(resolve, 25)); }
		throw new Error(`Native daemon condition not reached. ${logs}\n${terminalText.slice(-6000)}`);
	};
	try {
		await anton.connect();
		const workspace = randomUUID();
		const id = await anton.createSession('Cross-client proof', workspace, repository);
		expect(anton.repositoryRoot).toBe(repository);
		const session = (await anton.listSessions()).find(item => item.session_id === id)!;
		await observer.connect(session);
		const knowledge = await observer.readService({ type: 'ReadKnowledge', session_id: id, section: { type: 'Memories' }, offset: 0, limit: 10 });
		expect(knowledge.type).toBe('KnowledgePage');
		await expect(anton.rememberMemory('-----BEGIN PRIVATE KEY-----\nsynthetic refusal fixture\n-----END PRIVATE KEY-----')).rejects.toThrow(/memory not saved/);
		await anton.rememberMemory('I prefer explicit validation evidence.');
		const built = await anton.buildCodeGraph(repository);
		expect(built.type).toBe('CodeGraphBuilt');
		const graph = await observer.readService({ type: 'ReadCodeGraph', repository, query: { name: 'shared', include_nodes: true, include_edges: true, limit: 10 } });
		expect(graph.type).toBe('CodeGraphPage');
		if (graph.type === 'CodeGraphPage') { expect(graph.page.nodes.some(node => node.qualified_name.endsWith('shared'))).toBe(true); }

		const scope = { type: 'RepositoryBoard' as const, repository };
		const added = await anton.writeBoard({ type: 'PostBlackboardItem', scope, item: { kind: 'task', payload: { title: 'Review the shared runtime' }, status: 'todo' } });
		expect(added.type).toBe('BlackboardItemApplied');
		if (added.type !== 'BlackboardItemApplied') { throw new Error('No durable board receipt.'); }
		const moved = await anton.writeBoard({ type: 'UpdateBlackboardItem', scope, item_id: added.item.id, status: 'review' });
		expect(moved.type).toBe('BlackboardItemApplied');
		await expect(anton.writeBoard({ type: 'UpdateBlackboardItem', scope, item_id: added.item.id, status: 'done' })).rejects.toThrow();
		const board = await observer.readService({ type: 'ReadBlackboard', workflow_run_id: '', board_repository: repository, include_superseded: false });
		expect(board.type).toBe('BlackboardItems');
		if (board.type === 'BlackboardItems') { expect(board.items.some(item => item.status === 'review')).toBe(true); }

		await anton.submit('Explain this project in one sentence.', 'Ask');
		await until(() => requested);
		await writeFile(path.join(data, 'tui-sessions.json'), JSON.stringify({ sessions: { [repository]: { session_id: id, workspace_id: workspace } }, onboard_skipped: true }));
		if (process.env.CODYPENDENT_TEST_TUI === '1') {
			openTerminal();
			const enter = setInterval(() => terminal?.stdin?.write('\r'), 200);
			try { await until(() => terminalText.includes('Explain this project')); }
			finally { clearInterval(enter); }
			await closeTerminal();
		}
		anton.disconnect();
		releaseModel!();
		await until(() => observer.snapshot.projection.rows.some(row => row.text.includes('Shared runtime verified.')));
		await until(() => observer.snapshot.projection.activeRuns.length === 0);
		if (process.env.CODYPENDENT_TEST_TUI === '1') {
			openTerminal();
			const enter = setInterval(() => terminal?.stdin?.write('\r'), 200);
			try { await until(() => terminalText.includes('Shared runtime verified.')); }
			finally { clearInterval(enter); }
			await closeTerminal();
		}
		await reopened.connect(session);
		expect(reopened.snapshot.projection.rows.some(row => row.text.includes('Shared runtime verified.'))).toBe(true);
		expect(reopened.snapshot.projection.activeRuns).toEqual([]);
	} finally {
		await closeTerminal(); anton.disconnect(); observer.disconnect(); reopened.disconnect(); releaseModel?.();
		const exited = new Promise<void>(resolve => { if (daemon.exitCode !== null || daemon.signalCode !== null) { resolve(); } else { daemon.once('exit', () => resolve()); } });
		daemon.kill('SIGTERM'); await exited;
		server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(directory, { recursive: true, force: true });
	}
}, 30000);
