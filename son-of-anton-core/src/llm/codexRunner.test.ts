/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { runCodex, type CodexChunk } from './codexRunner';

async function fixture(t: { after(fn: () => Promise<void>): void }, program: string) {
	const cwd = await mkdtemp(path.join(tmpdir(), 'sota-codex-transport-'));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const executable = path.join(cwd, 'codex');
	await writeFile(executable, `#!${process.execPath}\n${program}\n`);
	await chmod(executable, 0o700);
	return { cwd, codexPath: executable, modelId: 'gpt-5', systemPrompt: 'Respond concisely.', messages: [{ role: 'user' as const, content: 'Hello' }] };
}
const collect = async (stream: AsyncIterable<CodexChunk>) => { const chunks = []; for await (const chunk of stream) { chunks.push(chunk); } return chunks; };

test('Codex exec JSONL returns assistant text and usage after a successful turn', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
	const options = await fixture(t, `let prompt=''; process.stdin.on('data', data => prompt+=data); process.stdin.on('end', () => {
		const args=process.argv.slice(2);
		if (args[0]!=='exec' || !args.includes('--json') || !args.includes('--ignore-user-config') || args[args.indexOf('--sandbox')+1]!=='read-only' || !args.includes('features.shell_tool=false') || !args.includes('developer_instructions="Respond concisely."') || !prompt.includes('Hello')) process.exit(2);
		for (const event of [{type:'thread.started',thread_id:'fixture'}, {type:'item.completed',item:{type:'reasoning',text:'Private reasoning'}}, {type:'item.completed',item:{type:'agent_message',text:'Hello!'}}, {type:'turn.completed',usage:{input_tokens:20,output_tokens:3}}]) console.log(JSON.stringify(event));
	});`);
	assert.deepEqual(await collect(runCodex(options)), [{ type: 'text', text: 'Hello!' }, { type: 'usage', inputTokens: 20, outputTokens: 3 }, { type: 'done' }]);
});

test('Codex failures never report successful completion', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
	const options = await fixture(t, `process.stdin.resume(); process.stdin.on('end', () => { console.error('Authentication expired'); process.exitCode=2; });`);
	assert.deepEqual(await collect(runCodex(options)), [{ type: 'error', message: 'Codex CLI exited 2: Authentication expired' }]);
});

test('Codex missing executable is reported without an unhandled error or hanging', { timeout: 10000 }, async () => {
	const chunks = await collect(runCodex({ codexPath: '/nonexistent/sota-codex', modelId: 'gpt-5', systemPrompt: '', messages: [] }));
	assert.equal(chunks.length, 1);
	assert.match(chunks[0].type === 'error' ? chunks[0].message : '', /Unable to start Codex CLI/);
});

test('Codex cancellation closes an active process without reporting success', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
	const options = await fixture(t, `process.stdin.resume(); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Started'}})); setInterval(()=>{},1000);`);
	const controller = new AbortController();
	const chunks = [];
	for await (const chunk of runCodex({ ...options, signal: controller.signal })) { chunks.push(chunk); controller.abort(); }
	assert.deepEqual(chunks, [{ type: 'text', text: 'Started' }]);
});

test('Codex rejects truncated successful-exit output', { skip: process.platform === 'win32', timeout: 10000 }, async t => {
	const options = await fixture(t, `process.stdin.resume(); console.log('not a JSON event');`);
	assert.deepEqual(await collect(runCodex(options)), [{ type: 'error', message: 'Codex CLI exited without completing a response.' }]);
});
