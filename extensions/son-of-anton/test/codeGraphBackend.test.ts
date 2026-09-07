/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { strict as assert } from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as vscode from 'vscode';
import { CodeGraphBackend } from '../src/codeGraph/CodeGraphBackend';

suite('Embedded graph lifecycle', () => {
	test('a slow previous workspace cannot replace the latest serving descriptor', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sota-graph-owner-'));
		const first = path.join(directory, 'first');
		const second = path.join(directory, 'second');
		fs.mkdirSync(first); fs.mkdirSync(second);
		fs.mkdirSync(path.join(directory, 'runtime/codegraph'), { recursive: true });
		fs.writeFileSync(path.join(directory, 'runtime/codegraph/index.cjs'), '');
		let workspace = first;
		const backend = new CodeGraphBackend({ repoRoot: directory, extensionPath: directory, storageDir: path.join(directory, 'storage'), workspaceRoot: first, getWorkspaceRoot: () => workspace, output: { append() {}, show() {} } as unknown as vscode.OutputChannel, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) as vscode.WorkspaceConfiguration });
		const realpath = fs.promises.realpath;
		let release!: () => void;
		const blocked = new Promise<void>(resolve => { release = resolve; });
		fs.promises.realpath = (async (target: fs.PathLike) => { if (target === first) { await blocked; } return realpath(target); }) as typeof realpath;
		try {
			const old = backend.start();
			workspace = second;
			await backend.start();
			release();
			await old;
			assert.equal(backend.getMcpServerEntry()?.cwd, await realpath(second));
		} finally {
			release();
			fs.promises.realpath = realpath;
			backend.dispose();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
