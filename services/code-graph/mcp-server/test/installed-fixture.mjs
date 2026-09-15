/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const sourceRuntime = process.env.SOTA_RUNTIME_SOURCE || fileURLToPath(new URL('../../../../extensions/son-of-anton/runtime/codegraph/', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fixture(t) {
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

export async function connect(fixture, extra = [], environment = {}) {
	const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(fixture.runtime, 'index.cjs'), `--db=${path.join(fixture.directory, 'graph.db')}`, `--index-root=${fixture.workspace}`, ...extra], cwd: fixture.workspace, env: { PATH: process.env.PATH || '', ELECTRON_RUN_AS_NODE: '1', ...environment }, stderr: 'pipe' });
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
	const until = async (predicate, timeout = 20000) => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			try { if (await predicate()) { return; } }
			catch (error) { if (!/still indexing/.test(error.message)) { throw error; } }
			await wait(100);
		}
		throw new Error(`MCP fixture timed out: ${logs}`);
	};
	return { client, call, until, pid: transport.pid };
}
