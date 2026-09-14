/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { IsolatedWorkspace } from './IsolatedWorkspace';
import { validationCommands, runProposalValidation } from './ProposalValidation';

async function fixture(t: { after(fn: () => Promise<void>): void }, testBody = "const fs=require('node:fs');if(fs.readFileSync('a.txt','utf8')!=='fixed')process.exit(7)") {
	const directory = await realpath(await mkdtemp(join(tmpdir(), 'sota-validation-'))), root = join(directory, 'project'); await mkdir(root);
	t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim();
	git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
	await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { build: 'node --check test.cjs', test: 'node test.cjs' } }));
	await writeFile(join(root, 'test.cjs'), testBody); await writeFile(join(root, 'a.txt'), 'original'); await writeFile(join(root, 'b.txt'), 'other');
	git('add', '.'); git('commit', '-qm', 'fixture');
	const store = new IsolatedWorkspace(join(directory, 'proposals')), proposal = await store.create(root);
	await writeFile(join(proposal.worktree, 'a.txt'), 'fixed'); await writeFile(join(proposal.worktree, 'b.txt'), 'proposed');
	const review = await store.finish(proposal.id, 'review'); return { root, store, review, git };
}
test('host validation certifies only the selected candidate and partial apply preserves the index', async t => {
	const { root, store, review, git } = await fixture(t);
	await writeFile(join(root, 'b.txt'), 'user edit'); git('add', 'b.txt');
	const evidence = await store.prepareValidation(review.id, review.digest!, ['a.txt']);
	assert.equal(await readFile(join(evidence.workspace, 'b.txt'), 'utf8'), 'user edit');
	const result = await runProposalValidation(store, evidence, await validationCommands(evidence.workspace));
	assert.deepEqual([result.status, result.commands.map(command => command.exitCode)], ['passed', [0, 0]]);
	await assert.rejects(store.apply(review.id, review.digest!, ['a.txt', 'b.txt'], result.id), /stale/);
	const partial = await store.apply(review.id, review.digest!, ['a.txt'], result.id);
	assert.deepEqual([partial.status, partial.appliedFiles, git('show', ':b.txt')], ['review', ['a.txt'], 'user edit']);
	await writeFile(join(root, 'b.txt'), 'new unrelated edit'); await store.restoreLastApplication(review.id);
	assert.deepEqual([await readFile(join(root, 'a.txt'), 'utf8'), await readFile(join(root, 'b.txt'), 'utf8'), git('show', ':b.txt')], ['original', 'new unrelated edit', 'user edit']);
});
test('failed real test exits are retained and cannot certify application', async t => {
	const { store, review } = await fixture(t, 'console.error("regression failure"); process.exit(7)');
	const evidence = await store.prepareValidation(review.id, review.digest!, ['a.txt']);
	const result = await runProposalValidation(store, evidence, (await validationCommands(evidence.workspace)).filter(command => command.script === 'test'));
	assert.deepEqual([result.status, result.commands[0].exitCode], ['failed', 7]); assert.match(await readFile(result.commands[0].log, 'utf8'), /regression failure/);
	await assert.rejects(store.apply(review.id, review.digest!, ['a.txt'], result.id), /did not pass/);
});
test('a later workspace edit invalidates previously passing evidence', async t => {
	const { root, store, review } = await fixture(t);
	const evidence = await store.prepareValidation(review.id, review.digest!, ['a.txt']);
	await runProposalValidation(store, evidence, await validationCommands(evidence.workspace));
	await writeFile(join(root, 'b.txt'), 'new input');
	await assert.rejects(store.apply(review.id, review.digest!, ['a.txt'], evidence.id), /stale/);
});
test('approval detects script edits and command rewrites never count as passing tests', async t => {
	const { store, review } = await fixture(t, "require('node:fs').writeFileSync('a.txt','changed by test')");
	const evidence = await store.prepareValidation(review.id, review.digest!, ['a.txt']), commands = await validationCommands(evidence.workspace);
	const original = await readFile(join(evidence.workspace, 'package.json'));
	await writeFile(join(evidence.workspace, 'package.json'), '{"scripts":{"test":"node -e process.exit(0)"}}');
	await assert.rejects(runProposalValidation(store, evidence, commands), /changed after approval/);
	await writeFile(join(evidence.workspace, 'package.json'), original);
	assert.equal((await runProposalValidation(store, evidence, commands)).status, 'stale');
});
test('timeouts terminate a long-running command and cancellation runs no commands', async t => {
	const { store, review } = await fixture(t, 'setInterval(()=>{},1000)');
	const evidence = await store.prepareValidation(review.id, review.digest!, ['a.txt']);
	assert.equal((await runProposalValidation(store, evidence, (await validationCommands(evidence.workspace)).filter(command => command.script === 'test'), undefined, 1000)).status, 'timed-out');
	const next = await store.prepareValidation(review.id, review.digest!, ['a.txt']);
	const abort = new AbortController(); abort.abort();
	const result = await runProposalValidation(store, next, await validationCommands(next.workspace), abort.signal);
	assert.deepEqual([result.status, result.commands.length], ['cancelled', 0]);
});
test('restore refuses newer edits to applied files and restart labels interrupted validation', async t => {
	const { root, store, review } = await fixture(t);
	const evidence = await store.prepareValidation(review.id, review.digest!, ['a.txt']); evidence.status = 'running'; evidence.ownerPid = 2147483647; await store.recordValidation(evidence);
	assert.equal((await new IsolatedWorkspace(store.directory).load(review.id)).validation?.status, 'interrupted');
	await store.apply(review.id, review.digest!, ['a.txt']); await writeFile(join(root, 'a.txt'), 'later edit');
	await assert.rejects(store.restoreLastApplication(review.id), /newer edits/); assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'later edit');
});
