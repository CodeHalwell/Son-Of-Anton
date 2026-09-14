/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runClaudeCode, resetClaudeCodeAvailability } from './claudeCodeRunner';

test('Claude subscription transport excludes inherited MCPs and skills while retaining subscription auth', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
	const dir = await mkdtemp(path.join(tmpdir(), 'sota-claude-transport-'));
	const executable = path.join(dir, 'claude');
	await writeFile(executable, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { const args=process.argv.slice(2); const isolated=args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands') && args[args.indexOf('--mcp-config')+1] === '{"mcpServers":{}}' && args[args.indexOf('--tools')+1] === '' && !args.includes('--bare') && !process.env.ANTHROPIC_API_KEY; process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:isolated?'isolated':'incorrect'}]}})+'\\n'); });\n`);
	await chmod(executable, 0o700);
	const oldPath = process.env.PATH; const oldKey = process.env.ANTHROPIC_API_KEY;
	process.env.PATH = dir + path.delimiter + oldPath; process.env.ANTHROPIC_API_KEY = 'fixture-key'; resetClaudeCodeAvailability();
	t.after(async () => { process.env.PATH = oldPath; if (oldKey === undefined) { delete process.env.ANTHROPIC_API_KEY; } else { process.env.ANTHROPIC_API_KEY = oldKey; } resetClaudeCodeAvailability(); await rm(dir, { recursive: true, force: true }); });
	const chunks = [];
	for await (const chunk of runClaudeCode({ claudePath: executable, cwd: dir, modelId: 'haiku', systemPrompt: 'Fixture', messages: [{ role: 'user', content: 'Hello' }] })) { chunks.push(chunk); }
	assert.deepEqual(chunks, [{ type: 'text', text: 'isolated' }, { type: 'done' }]);
});
