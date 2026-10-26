/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createRequire } from 'node:module';
const { build } = createRequire(new URL('../son-of-anton-cli/package.json', import.meta.url))('esbuild');
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withStagedDirectory } from './staged-directory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const debug = process.argv.includes('--debug');
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
// Upstream ORT supports an explicitly supplied SDK. Keep that path usable for
// offline builders, including its shared libraries and licence notices in the
// final artifact. Ordinary CI retains the pinned ort-sys binary distribution.
const systemOrt = process.platform === 'linux' && process.env.ORT_PREFER_DYNAMIC_LINK === '1' && process.env.ORT_LIB_LOCATION;
if (systemOrt && (!process.env.ORT_LICENSE_FILE || !process.env.ORT_NOTICES_FILE)) {
	throw new Error('A dynamic ONNX SDK requires ORT_LICENSE_FILE and ORT_NOTICES_FILE for redistribution.');
}
if (systemOrt) {
	const version = execFileSync('python3', ['-c', `import ctypes,sys
class ApiBase(ctypes.Structure):
	_fields_=[('get_api',ctypes.c_void_p),('version',ctypes.CFUNCTYPE(ctypes.c_char_p))]
library=ctypes.CDLL(sys.argv[1]);library.OrtGetApiBase.restype=ctypes.POINTER(ApiBase)
print(library.OrtGetApiBase().contents.version().decode())`, path.join(systemOrt, 'libonnxruntime.so.1.22.0')], { encoding: 'utf8' }).trim();
	if (version !== '1.22.0') { throw new Error(`ONNX Runtime 1.22.0 is required; supplied SDK reports ${version}`); }
}
run('cargo', [systemOrt ? 'rustc' : 'build', '--locked', '-p', 'sota-codegraph-napi', ...(debug ? [] : ['--release']),
	...(systemOrt ? ['--', '-C', 'link-arg=-Wl,-rpath,$ORIGIN'] : [])], path.join(root, 'crates'));
const output = path.join(root, 'extensions/son-of-anton/runtime/codegraph');
await withStagedDirectory(output, async staged => {
	const native = path.join(staged, 'node_modules/@son-of-anton/codegraph-napi');
	await mkdir(native, { recursive: true });
	const filename = process.platform === 'win32' ? 'sota_codegraph_napi.dll' : process.platform === 'darwin' ? 'libsota_codegraph_napi.dylib' : 'libsota_codegraph_napi.so';
	await copyFile(path.join(root, 'crates/target', debug ? 'debug' : 'release', filename), path.join(native, 'engine.node'));
	await writeFile(path.join(native, 'index.js'), `module.exports = require('./engine.node');\n`);
	await writeFile(path.join(native, 'package.json'), JSON.stringify({ name: '@son-of-anton/codegraph-napi', version: '0.1.0', main: 'index.js' }));
	let onnxRuntime;
	if (systemOrt) {
		const files = [];
		for (const [name, original] of [['libonnxruntime.so.1', 'libonnxruntime.so.1.22.0'], ['libonnxruntime_providers_shared.so', 'libonnxruntime_providers_shared.so']]) {
			const from = path.join(systemOrt, original);
			const bytes = await readFile(from);
			await copyFile(from, path.join(native, name));
			files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
		}
		await copyFile(process.env.ORT_LICENSE_FILE, path.join(native, 'ONNX-RUNTIME-LICENSE'));
		await copyFile(process.env.ORT_NOTICES_FILE, path.join(native, 'ONNX-RUNTIME-NOTICES'));
		onnxRuntime = { version: '1.22.0', linkage: 'bundled-shared', files };
	}
	await build({ entryPoints: ['index', 'engine-worker'].map(name => path.join(root, `services/code-graph/mcp-server/src/${name}.ts`)), outdir: staged, outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['@son-of-anton/codegraph-napi'], logLevel: 'warning' });
	await writeFile(path.join(staged, 'manifest.json'), JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, nodeMajor: 22, worker: 'engine-worker.cjs', native: 'node_modules/@son-of-anton/codegraph-napi/engine.node', onnxRuntime }, null, '\t') + '\n');
});
console.log(`Code graph runtime: ${output}`);
