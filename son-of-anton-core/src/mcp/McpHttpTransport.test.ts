/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpClient } from './McpClient';

test('remote MCP negotiates a session, discovers schemas, calls tools and cancels requests', { timeout: 15_000 }, async t => {
	const methods: string[] = [];
	const headers: string[] = [];
	let slowStarted!: () => void;
	const slow = new Promise<void>(resolve => { slowStarted = resolve; });
	let cancelled!: () => void;
	const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
	const server = createServer(async (req, res) => {
		if (req.method !== 'POST') { res.writeHead(405).end(); return; }
		const chunks: Buffer[] = [];
		for await (const chunk of req) { chunks.push(Buffer.from(chunk)); }
		const message = JSON.parse(Buffer.concat(chunks).toString());
		methods.push(message.method); headers.push(String(req.headers.authorization));
		if (message.method === 'notifications/cancelled') { cancelled(); }
		if (message.id === undefined) { res.writeHead(202).end(); return; }
		if (message.method === 'tools/call' && message.params.arguments.slow) { slowStarted(); return; }
		res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' });
		const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
			: message.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, annotations: { readOnlyHint: true } }] }
				: { content: [{ type: 'text', text: message.params.arguments.value }] };
		res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const states: string[] = [];
	const client = new McpClient({ readServersSetting: async () => [{ name: 'remote', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, headers: { Authorization: 'Bearer fixture' } }], getWorkspaceRoot: () => undefined, onSettingChange: () => ({ dispose() {} }), onServerState: (_name, state) => states.push(state) });
	t.after(() => client.dispose());
	const tools = await client.listTools();
	assert.equal(tools[0]?.tool, 'echo');
	assert.deepEqual(tools[0]?.inputSchema, { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] });
	assert.equal((await client.callTool({ server: 'remote', tool: 'echo', inputs: { value: 'working' } })).content, 'working');
	const controller = new AbortController();
	const pending = client.callTool({ server: 'remote', tool: 'echo', inputs: { value: 'cancel me', slow: true }, signal: controller.signal });
	const rejected = assert.rejects(pending, /cancelled/);
	await slow; controller.abort();
	await rejected;
	await cancellation;
	assert.ok(states.includes('ready'));
	assert.ok(methods.includes('notifications/initialized'));
	assert.ok(methods.indexOf('notifications/initialized') < methods.indexOf('tools/list'));
	assert.ok(headers.every(header => header === 'Bearer fixture'));
});
