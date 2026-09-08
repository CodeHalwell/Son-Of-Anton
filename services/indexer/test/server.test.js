/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { IndexerServer } = require('../dist/server.js');

test('file reindex routes preserve native absolute paths and resolve relative paths', async () => {
	const workspace = path.resolve('fixture workspace'), files = [];
	const indexer = { indexFile: async file => { files.push(file); return true; } };
	const server = new IndexerServer(indexer, { project: { path: workspace }, server: { port: 0 } });
	const inputs = ['src/file.ts', path.join(workspace, 'absolute.ts')];
	if (process.platform === 'win32') { inputs.push('\\\\server\\share\\file.ts'); }
	for (const file of inputs) {
		let status;
		await server.handleRequest({ method: 'POST', url: '/reindex/' + encodeURIComponent(file), headers: { authorization: 'Bearer ' + process.env.SOTA_SERVICE_TOKEN } }, { writeHead(value) { status = value; }, end() {} });
		assert.equal(status, 200);
	}
	assert.deepEqual(files, inputs.map(file => path.isAbsolute(file) ? file : path.join(workspace, file)));
});
