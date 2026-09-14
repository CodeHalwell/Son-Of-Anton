/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpServer } = require('../dist/server.js');

test('MCP clients discover all tools and receive schema validation before execution', async t => {
	let queries = 0;
	const server = createMcpServer({ query: async () => { queries++; return { headers: [], rows: [] }; } }, {});
	const client = new Client({ name: 'registration-test', version: '1.0.0' });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	t.after(async () => { await client.close(); await server.close(); });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	assert.equal(new Set(tools.map(tool => tool.name)).size, 17);
	for (const tool of tools) { assert.equal(tool.inputSchema.type, 'object'); }
	const valid = await client.callTool({ name: 'symbol_lookup', arguments: { name: 'fixture', type: 'function' } });
	assert.notEqual(valid.isError, true); assert.equal(queries, 1);
	for (const args of [{ name: 'fixture', type: 'invalid' }, { name: 42 }, {}]) {
		const invalid = await client.callTool({ name: 'symbol_lookup', arguments: args });
		assert.equal(invalid.isError, true);
	}
	assert.equal(queries, 1, 'Invalid requests must never reach the database');
});
