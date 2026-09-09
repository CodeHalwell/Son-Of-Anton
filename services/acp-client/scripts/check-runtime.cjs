/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const serviceRequire = Module.createRequire(path.join(__dirname, '../package.json'));
const dependencies = new Set(Object.keys(serviceRequire('./package.json').dependencies));
const runtimeRoot = fs.realpathSync(path.join(__dirname, '../_shared/acp/dist'));
const isStaged = file => file === runtimeRoot || file.startsWith(runtimeRoot + path.sep);
const resolveFilename = Module._resolveFilename;

// Restrict core imports to staged files and declared service dependencies, so
// extra SDKs installed elsewhere in the monorepo cannot mask packaging defects.
Module._resolveFilename = function (request, parent, ...options) {
	if (parent?.filename && isStaged(parent.filename) && !Module.isBuiltin(request)) {
		if (request.startsWith('.') || path.isAbsolute(request)) {
			const resolved = resolveFilename.call(this, request, parent, ...options);
			if (!isStaged(fs.realpathSync(resolved))) { throw new Error(`ACP import escapes the staged runtime: ${request}`); }
			return resolved;
		}
		const packageName = request.split('/').slice(0, request.startsWith('@') ? 2 : 1).join('/');
		if (!dependencies.has(packageName)) { throw new Error(`ACP runtime dependency is not declared by the service: ${packageName}`); }
		return serviceRequire.resolve(request);
	}
	return resolveFilename.call(this, request, parent, ...options);
};

// Construct and release the packaged runtime without launching an adapter.
async function check() {
	try {
		const { AcpRuntime } = require('../_shared/acp/dist/acp/AcpRuntime');
		await new AcpRuntime().shutdown();
	} finally { Module._resolveFilename = resolveFilename; }
}
check().catch(error => { console.error(error); process.exitCode = 1; });
