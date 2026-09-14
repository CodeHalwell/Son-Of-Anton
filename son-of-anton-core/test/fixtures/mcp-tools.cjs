/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const readline = require('node:readline');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
let cancellations = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
	const { id, method, params } = JSON.parse(line);
	if (method === 'initialize') { send(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }); }
	if (method === 'tools/list') {
		send(id, { tools: ['mutate', 'wait', 'status'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: { value: { type: 'string', minLength: 1 } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: name !== 'mutate' } })) });
	}
	if (method === 'tools/call' && params.name !== 'wait') { send(id, { content: [{ type: 'text', text: params.name === 'status' ? String(cancellations) : `accepted:${params.arguments.value}` }] }); }
	if (method === 'notifications/cancelled') { cancellations++; }
});
