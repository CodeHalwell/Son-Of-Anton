/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { McpClient } from './McpClient';

test('retrying unchanged settings reconnects a crashed server and host notifications cannot initialize servers', { timeout: 15000 }, async t => {
	const root = await mkdtemp(path.join(tmpdir(), 'sota-mcp-recovery-'));
	const script = path.join(root, 'server.cjs');
	await writeFile(script, `const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
const { id, method, params } = JSON.parse(line); const send = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
if (method === 'initialize') send({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'recovery', version: '1' } });
if (method === 'tools/list') send({ tools: [{ name: 'exit', description: 'Exit fixture', inputSchema: { type: 'object', properties: {} } }] });
if (method === 'tools/call') process.exit(1);
});`);
	let changed: (() => void) | undefined, ready = 0;
	const client = new McpClient({ readServersSetting: () => [{ name: 'fixture', command: process.execPath, args: [script] }], getWorkspaceRoot: () => root, onSettingChange: listener => { changed = listener; return { dispose() {} }; }, onServerState: (_name, state) => { if (state === 'ready') { ready++; } } });
	t.after(async () => { client.dispose(); await rm(root, { recursive: true, force: true }); });
	assert.equal(await client.notifyServer('fixture', 'notifications/son-of-anton/test', {}), false);
	assert.equal(ready, 0);
	await client.listTools();
	assert.equal(await client.notifyServer('fixture', 'notifications/son-of-anton/test', {}, '/wrong-command'), false);
	await client.callTool({ server: 'fixture', tool: 'exit', inputs: {} }).catch(() => undefined);
	changed?.();
	for (let attempt = 0; attempt < 100 && ready < 2; attempt++) { await new Promise(resolve => setTimeout(resolve, 40)); }
	assert.equal(ready, 2);
	assert.equal(await client.notifyServer('fixture', 'notifications/son-of-anton/test', {}, process.execPath), true);
});
