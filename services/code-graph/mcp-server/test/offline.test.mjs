/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sourceRuntime = process.env.SOTA_RUNTIME_SOURCE || fileURLToPath(new URL('../../../../extensions/son-of-anton/runtime/codegraph/', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sota-installed-'));
	// Close clients and providers before deleting files held open by SQLite/watchers on Windows.
	const cleanups = [() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })];
	t.after(async () => {
		const errors = [];
		for (const cleanup of cleanups.reverse()) {
			try { await cleanup(); } catch (error) { errors.push(error); }
		}
		if (errors.length) { throw new AggregateError(errors, 'Installed graph fixture cleanup failed'); }
	});
	const runtime = path.join(directory, 'app/runtime');
	const workspace = path.join(directory, 'workspace');
	await fs.cp(sourceRuntime, runtime, { recursive: true });
	await fs.mkdir(workspace);
	await fs.writeFile(path.join(workspace, 'settings.ts'), 'export function loadProjectSettings() { return "load saved project settings"; }\n');
	await fs.writeFile(path.join(workspace, 'retry.ts'), 'export function scheduleRetry() { return "retry failed network requests"; }\n');
	return { directory, runtime, workspace, cleanups };
}

async function connect(fixture, extra = []) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(fixture.runtime, 'index.cjs'), `--db=${path.join(fixture.directory, 'graph.db')}`, `--index-root=${fixture.workspace}`, ...extra], cwd: fixture.workspace, env: { PATH: process.env.PATH || '', ELECTRON_RUN_AS_NODE: '1' }, stderr: 'pipe' });
	let logs = '';
	const client = new Client({ name: 'offline-fixture', version: '1' });
	fixture.cleanups.push(() => client.close());
	transport.stderr?.on('data', chunk => { logs = (logs + chunk).slice(-16000); });
	await client.connect(transport);
	const call = async (name, args = {}) => {
		const result = await client.callTool({ name, arguments: args });
		if (result.isError) { throw new Error(result.content[0].text); }
		return JSON.parse(result.content[0].text);
	};
	const until = async predicate => {
		const deadline = Date.now() + 20000;
		while (Date.now() < deadline) {
			try { if (await predicate()) { return; } }
			catch (error) { if (!/still indexing/.test(error.message)) { throw error; } }
			await wait(100);
		}
		throw new Error(`MCP fixture timed out: ${logs}`);
	};
	return { client, call, until };
}

test('installed native graph indexes, embeds, searches, watches edits and isolates workspaces offline', { timeout: 45000 }, async t => {
	const app = await fixture(t);
	let embeddingRequests = 0;
	const provider = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) { chunks.push(chunk); }
		const body = JSON.parse(Buffer.concat(chunks).toString());
		embeddingRequests++;
		const data = body.input.map((input, index) => ({ index, embedding: /settings/i.test(input) ? [1, 0, 0] : /retry/i.test(input) ? [0, 1, 0] : [0, 0, 1] }));
		res.writeHead(200, { 'content-type': 'application/json' });
		// Reversed response order checks provider index handling as well.
		res.end(JSON.stringify({ data: data.reverse() }));
	});
	await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
	app.cleanups.push(() => new Promise(resolve => { provider.close(resolve); provider.closeAllConnections(); }));
	const live = await connect(app, [`--provider-embedder=http://127.0.0.1:${provider.address().port}/embeddings|fixture-v1|3`]);
	await live.until(async () => (await live.call('codegraph_status')).semantic === 'ready');
	assert.equal((await live.call('codegraph_status')).stats.totalFiles, 2);
	const queries = [['load saved project settings', 'loadProjectSettings'], ['retry failed network requests', 'scheduleRetry']];
	const samples = [];
	for (const [query, expected] of queries) {
		const start = performance.now();
		const hits = await live.call('semantic_search', { query, limit: 1 });
		assert.equal(hits[0]?.symbol, expected);
		samples.push({ query, expected, retrieved: hits[0].symbol, latencyMs: performance.now() - start });
	}
	assert.ok(embeddingRequests >= 3);
	await fs.writeFile(path.join(app.workspace, 'settings.ts'), 'export function readCurrentSettings() { return "updated settings body"; }\n');
	await live.until(async () => (await live.call('codegraph_status')).structural && (await live.call('symbol_lookup', { query: 'readCurrentSettings' })).length === 1);
	assert.deepEqual(await live.call('symbol_lookup', { query: 'loadProjectSettings' }), []);
	await fs.rename(path.join(app.workspace, 'settings.ts'), path.join(app.workspace, 'moved.ts'));
	await live.until(async () => (await live.call('codegraph_status')).structural && (await live.call('symbol_lookup', { query: 'readCurrentSettings' }))[0]?.file.endsWith('moved.ts'));
	await fs.unlink(path.join(app.workspace, 'moved.ts'));
	await live.until(async () => (await live.call('codegraph_status')).structural && (await live.call('symbol_lookup', { query: 'readCurrentSettings' })).length === 0);
	await assert.rejects(live.call('semantic_search', { query: 'retry', limit: -1 }), /positive integer/);
	await live.client.close();
	const restarted = await connect(app);
	await restarted.until(async () => (await restarted.call('codegraph_status')).state === 'ready');
	assert.equal((await restarted.call('symbol_lookup', { query: 'scheduleRetry' })).length, 1);
	assert.deepEqual(await restarted.call('symbol_lookup', { query: 'readCurrentSettings' }), []);
	assert.equal((await restarted.call('codegraph_status')).stats.totalFiles, 1);
	await restarted.client.close();
	const otherWorkspace = path.join(app.directory, 'other');
	await fs.mkdir(otherWorkspace);
	const other = await connect({ ...app, workspace: otherWorkspace });
	await other.until(async () => (await other.call('codegraph_status')).state === 'failed');
	await assert.rejects(other.call('symbol_lookup', { query: 'scheduleRetry' }), /another workspace/);
	if (process.env.SOTA_EVAL_OUTPUT) {
		await fs.writeFile(process.env.SOTA_EVAL_OUTPUT, JSON.stringify({ fixture: 'retrieval-v1', embedding: 'deterministic-offline', recallAt1: 1, staleResults: 0, crossWorkspaceResults: 0, providerCalls: embeddingRequests, samples }, null, 2) + '\n');
	}
});

test('structural-only and missing-native installs advertise accurate capabilities', { timeout: 30000 }, async t => {
	const app = await fixture(t);
	const structural = await connect(app);
	await structural.until(async () => (await structural.call('codegraph_status')).state === 'ready');
	assert.equal((await structural.client.listTools()).tools.some(tool => tool.name === 'semantic_search'), false);
	await assert.rejects(structural.call('semantic_search', { query: 'settings' }), /disabled/);
	await structural.client.close();
	await fs.unlink(path.join(app.runtime, 'node_modules/@son-of-anton/codegraph-napi/engine.node'));
	const broken = await connect(app);
	await broken.until(async () => (await broken.call('codegraph_status')).state === 'failed');
	assert.deepEqual((await broken.client.listTools()).tools.map(tool => tool.name), ['codegraph_status']);
	await assert.rejects(broken.call('symbol_lookup', { query: 'settings' }), /could not start/);
});
