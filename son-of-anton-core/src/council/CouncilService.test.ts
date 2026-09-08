/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CouncilService } from './CouncilService';
import { CouncilStore } from './CouncilStore';
import { defaultCouncilGroup, councilDossier, parseCouncilAnswer, verifyCouncilCitation } from './prompts';
import { captureCouncilSnapshot } from './snapshot';
import type { CouncilRunner, CouncilSnapshot, CouncilTurn } from './types';

const snapshot: CouncilSnapshot = { workspace: '/tmp/example', head: 'a'.repeat(40), base: 'b'.repeat(40), digest: 'c'.repeat(64), capturedAt: 1, patch: 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old code\n+ changed code', files: ['example.ts'], limitations: ['Diff only'] };
const answer = (id: string) => JSON.stringify({ summary: `Independent ${id}`, findings: [{ title: 'Missing guard', severity: 'medium', file: 'example.ts', line: 1, evidence: 'changed code', detail: 'The changed path accepts invalid input.' }], dissent: ['A passing test is not evidence of complete coverage.'], questions: [] });
async function fixture(t: TestContext, run: (turn: CouncilTurn) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), 'sota-council-test-')); const released: string[] = [];
	const runner: CouncilRunner = { run: async turn => { await run(turn); return undefined; }, release: async id => { released.push(id); } };
	const store = new CouncilStore(directory); const service = new CouncilService(store, runner);
	t.after(async () => { await service.dispose(); await rm(directory, { recursive: true, force: true }); });
	return { service, store, released };
}

test('independent rounds respect concurrency, use a separate chair/reviewer, and publish durable snapshots', { timeout: 10_000 }, async t => {
	let active = 0; let peak = 0; const calls: CouncilTurn[] = [];
	let releasePair!: () => void; const pairStarted = new Promise<void>(resolve => { releasePair = resolve; });
	const { service, store, released } = await fixture(t, async turn => {
		calls.push(turn); active++; peak = Math.max(peak, active);
		if (calls.length === 2) { releasePair(); }
		await pairStarted; turn.onText(answer(turn.member.id)); active--;
	});
	const group = { ...defaultCouncilGroup(), rounds: 2 };
	const events: number[] = []; service.onChange(report => { events.push(report.sequence); });
	const report = await service.wait(await service.start('Audit the diff', group, snapshot));
	assert.deepEqual({ status: report.status, stages: report.stages.length, peak, releases: released.length, unique: new Set(released).size }, { status: 'completed', stages: 8, peak: 2, releases: 8, unique: 8 });
	assert.ok(calls.slice(0, 3).every(turn => !turn.prompt.includes('Independent code')));
	assert.ok(calls[3].prompt.includes('Independent code'));
	assert.equal((await store.load(report.id)).status, 'completed');
	assert.deepEqual(events, [...new Set(events)].sort((a, b) => a - b));
	assert.ok(report.stages.every(stage => stage.usage === undefined));
	assert.match(await readFile(await store.exportMarkdown(report.id), 'utf8'), /Usage: unavailable/);
});

test('one member failure preserves partial work and cannot contribute to quorum', async t => {
	const { service, released } = await fixture(t, async turn => { if (turn.member.id === 'code') { turn.onText('Partial evidence'); throw new Error('offline'); } turn.onText(answer(turn.member.id)); });
	const report = await service.wait(await service.start('Audit', { ...defaultCouncilGroup(), quorum: 3 }, snapshot));
	assert.deepEqual({ status: report.status, partial: report.stages[0].text, finished: report.stages.filter(stage => stage.status === 'completed').length, released: released.length }, { status: 'quorum-failed', partial: 'Partial evidence', finished: 2, released: 3 });
});

test('chair and final-review failures retain completed findings without claiming full success', async t => {
	for (const member of ['chair', 'final-review']) {
		const { service, store } = await fixture(t, async turn => { if (turn.member.id === member) { throw new Error('provider failed'); } turn.onText(answer(turn.member.id)); });
		const report = await service.wait(await service.start('Audit', defaultCouncilGroup(), snapshot));
		assert.equal(report.status, member === 'chair' ? 'chair-failed' : 'review-failed');
		assert.equal((await store.load(report.id)).stages.filter(stage => stage.kind === 'member' && stage.answer).length, 3);
	}
});

test('cancellation closes every started session and preserves partial responses', async t => {
	let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
	const { service, released } = await fixture(t, async turn => { turn.onText('In progress'); entered(); await new Promise<void>((_, reject) => turn.signal.addEventListener('abort', () => reject(turn.signal.reason), { once: true })); });
	const id = await service.start('Audit', defaultCouncilGroup(), snapshot); await started; service.cancel(id); const report = await service.wait(id);
	assert.equal(report.status, 'cancelled'); assert.ok(released.length >= 1); assert.ok(report.stages.some(stage => stage.text === 'In progress')); assert.ok(report.stages.every(stage => stage.status === 'cancelled'));
});

test('participant deadlines cannot silently become successful empty answers', async t => {
	const { service, released } = await fixture(t, async turn => { if (turn.member.id === 'code') { await new Promise<void>((_, reject) => turn.signal.addEventListener('abort', () => reject(turn.signal.reason), { once: true })); } else { turn.onText(answer(turn.member.id)); } });
	const report = await service.wait(await service.start('Audit', { ...defaultCouncilGroup(), turnTimeoutMs: 1000, quorum: 3 }, snapshot));
	assert.equal(report.status, 'quorum-failed'); assert.match(report.stages.find(stage => stage.member.id === 'code')!.error!, /deadline/); assert.equal(released.length, 3);
});

test('invalid groups, out-of-scope findings and oversized answers are rejected', async t => {
	const { service } = await fixture(t, async turn => turn.onText('x'.repeat(70_000)));
	await assert.rejects(service.start('Audit', { ...defaultCouncilGroup(), rounds: 4 }, snapshot), /rounds/);
	await assert.rejects(service.start('Audit', { ...defaultCouncilGroup(), chair: defaultCouncilGroup().members[0] }, snapshot), /distinct/);
	assert.throws(() => parseCouncilAnswer(answer('code'), ['other.ts']), /outside/);
	const report = await service.wait(await service.start('Audit', defaultCouncilGroup(), snapshot)); assert.equal(report.status, 'quorum-failed'); assert.ok(report.stages.every(stage => Buffer.byteLength(stage.text) <= 65536));
});

test('restart marks only exited owners interrupted and retains full member text', async t => {
	const { service, store } = await fixture(t, async turn => turn.onText(answer(turn.member.id)));
	const report = await service.wait(await service.start('Audit', defaultCouncilGroup(), snapshot)); report.status = 'running'; report.ownerPid = 2147483647; report.stages[0].status = 'running'; await store.save(report); await store.recover();
	const restored = await store.load(report.id); assert.equal(restored.status, 'interrupted'); assert.equal(restored.stages[0].text, report.stages[0].text); assert.equal(restored.stages[0].status, 'cancelled');
	assert.throws(() => store.path('../escape'), /Invalid/);
});

test('balanced synthesis includes the final participant and marks truncation', () => {
	const group = defaultCouncilGroup(); const stages = group.members.map(member => ({ id: member.id, member, round: 1, kind: 'member' as const, status: 'completed' as const, text: member.id.repeat(20000) }));
	const dossier = councilDossier(stages, 3000); assert.ok(dossier.length <= 3000); assert.match(dossier, /Security Reviewer/); assert.equal(dossier.match(/TRUNCATED/g)?.length, 3);
});

test('capture pins tracked changes without touching index, HEAD, stash or untracked files', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sota-council-git-')); t.after(() => rm(root, { recursive: true, force: true }));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
	git('init', '-q'); await writeFile(join(root, 'example.ts'), 'export const value = 1;\n'); git('add', 'example.ts'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
	const head = git('rev-parse', 'HEAD'); const index = git('write-tree'); await writeFile(join(root, 'example.ts'), 'export const value = 2;\n'); await writeFile(join(root, 'untracked.txt'), 'not included');
	const captured = await captureCouncilSnapshot(root); assert.match(captured.patch, /value = 2/); assert.deepEqual(captured.files, ['example.ts']); assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('write-tree'), index); assert.equal(git('stash', 'list'), '');
	await assert.rejects(captureCouncilSnapshot(root, '--output=/tmp/no'), /revision/);
});

test('persistence failure remains visible to late observers after the active slot is released', async t => {
	const { service, store } = await fixture(t, async turn => turn.onText(answer(turn.member.id)));
	const healthyStore = new CouncilStore(store.directory); let writes = 0;
	store.save = async report => { if (++writes > 1) { throw new Error('disk unavailable'); } await healthyStore.save(report); };
	const id = await service.start('Audit', defaultCouncilGroup(), snapshot);
	await assert.rejects(service.wait(id), /persist/);
	assert.equal(service.isOwned(id), false);
	await assert.rejects(service.wait(id), /persist/);
	assert.equal((await store.load(id)).status, 'running');
});

test('history index avoids loading report bodies and recovers stale or damaged entries', async t => {
	const { service, store } = await fixture(t, async turn => turn.onText(answer(turn.member.id)));
	const report = await service.wait(await service.start('Indexed history', defaultCouncilGroup(), snapshot));
	class CountedStore extends CouncilStore { reads = 0; override async load(id: string) { this.reads++; return super.load(id); } }
	const indexed = new CountedStore(store.directory);
	assert.equal((await indexed.summaries())[0]?.id, report.id); assert.equal(indexed.reads, 0);
	await writeFile(join(store.directory, `${report.id}.summary`), '{broken');
	assert.equal((await indexed.summaries())[0]?.objective, 'Indexed history'); assert.equal(indexed.reads, 1);
	await writeFile(join(store.directory, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json'), '{broken');
	assert.equal((await indexed.summaries()).length, 1);
	report.objective = 'Updated objective'; report.sequence++; await store.save(report);
	assert.equal((await indexed.summaries())[0]?.objective, 'Updated objective');
});


test('Council citations require matching old/new line and contiguous hunk evidence', () => {
	const patch = 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -10,2 +10,3 @@\n-removed guard\n+new guard\n+new check\n unchanged\n@@ -90 +91 @@\n-other\n+distant';
	assert.deepEqual([
		verifyCouncilCitation(patch, 'example.ts', 10, 'new guard\nnew check'),
		verifyCouncilCitation(patch, 'example.ts', 10, 'removed guard', 'old'),
		verifyCouncilCitation(patch, 'example.ts', 11, 'new guard'),
		verifyCouncilCitation(patch, 'example.ts', 10, 'removed guard'),
		verifyCouncilCitation(patch, 'example.ts', 12, 'unchanged\ndistant'),
		verifyCouncilCitation(patch, 'other.ts', 10, 'new guard'),
	], [true, true, false, false, false, false]);
});

test('fabricated excerpts are retained as failed stages and cannot satisfy quorum', async t => {
	const { service } = await fixture(t, async turn => turn.onText(answer(turn.member.id).replace('changed code', 'fabricated evidence')));
	const report = await service.wait(await service.start('Audit', defaultCouncilGroup(), snapshot));
	assert.equal(report.status, 'quorum-failed');
	assert.ok(report.stages.every(stage => stage.status === 'failed' && !stage.answer && stage.text.includes('fabricated evidence') && stage.error?.includes('does not match')));
});
