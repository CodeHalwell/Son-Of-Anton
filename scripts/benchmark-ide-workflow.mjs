/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url), { IsolatedWorkspace } = require('../son-of-anton-core/dist/workspace/IsolatedWorkspace');
const { validationCommands, runProposalValidation } = require('../son-of-anton-core/dist/workspace/ProposalValidation');
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'sota-workflow-scale-'))), workspace = path.join(directory, 'project');
const samples = [], measure = async (name, fn) => { const started = performance.now(); const value = await fn(); samples.push({ operation: name, durationMs: Math.round((performance.now() - started) * 100) / 100 }); return value; };
const sourceFiles = Number(process.env.SOTA_BENCHMARK_FILES || 1000);
assert.ok(Number.isInteger(sourceFiles) && sourceFiles >= 100 && sourceFiles <= 5000);
let live;
try {
	await mkdir(path.join(workspace, 'src/features'), { recursive: true }); await mkdir(path.join(workspace, 'test'));
	for (let start = 0; start < sourceFiles; start += 50) {
		await Promise.all(Array.from({ length: Math.min(50, sourceFiles - start) }, (_, offset) => { const index = start + offset; return writeFile(path.join(workspace, `src/features/feature-${index}.js`), `export function feature${index}(value) { return value + ${index}; }\n`); }));
	}
	await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'node --check src/clamp.js && node --check src/sum.js', test: 'node --test test/*.test.js' } }));
	await writeFile(path.join(workspace, 'src/clamp.js'), 'export const clamp = (value, min, max) => Math.max(min, Math.min(value, max));\n');
	await writeFile(path.join(workspace, 'src/sum.js'), 'export const sum = values => values.reduce((a,b) => a+b, 0);\n');
	await writeFile(path.join(workspace, 'test/baseline.test.js'), `import {test} from 'node:test';import assert from 'node:assert/strict';import {clamp} from '../src/clamp.js';test('clamp bounds',()=>assert.equal(clamp(15,0,10),10));\n`);
	const git = (...args) => { const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
	git('init', '-q'); git('config', 'user.name', 'Workflow Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-qm', 'Fixture baseline');
	await writeFile(path.join(workspace, 'user-notes.txt'), 'Preserve the existing uncommitted work.\n');
	const store = new IsolatedWorkspace(path.join(directory, 'proposals'));
	const proposals = [];
	for (let index = 0; index < 4; index++) { proposals.push(await measure('snapshot-and-worktree', () => store.create(workspace))); }
	await writeFile(path.join(proposals[0].worktree, 'src/clamp.js'), 'export const clamp = (value, min, max) => { if(min > max) throw new RangeError("inverted bounds"); return Math.max(min, Math.min(value, max)); };\n');
	await writeFile(path.join(proposals[0].worktree, 'test/clamp.test.js'), `import {test} from 'node:test';import assert from 'node:assert/strict';import {clamp} from '../src/clamp.js';test('inverted bounds',()=>assert.throws(()=>clamp(2,5,1),RangeError));\n`);
	await writeFile(path.join(proposals[1].worktree, 'src/sum.js'), 'export const sum = values => { if(values.some(value=>!Number.isFinite(value))) throw new TypeError("finite numbers required"); return values.reduce((a,b)=>a+b,0); };\n');
	await writeFile(path.join(proposals[1].worktree, 'test/sum.test.js'), `import {test} from 'node:test';import assert from 'node:assert/strict';import {sum} from '../src/sum.js';test('sum',()=>assert.equal(sum([1,2,3]),6));test('finite input',()=>assert.throws(()=>sum([NaN]),TypeError));\n`);
	await writeFile(path.join(proposals[2].worktree, 'src/clamp.js'), 'export const clamp = () => 0;\n');
	await writeFile(path.join(proposals[3].worktree, 'unfinished.md'), 'Interrupted task output retained.\n');
	const reviews = [];
	for (const proposal of proposals.slice(0, 3)) { reviews.push(await measure('finish', () => store.finish(proposal.id, 'review'))); }
	await store.finish(proposals[3].id, 'cancelled');
	assert.equal((await new IsolatedWorkspace(store.directory).load(proposals[3].id)).status, 'cancelled');
	for (const review of reviews.slice(0, 2)) {
		for (const file of review.files) { await measure('diff-preview', () => store.fileContent(review.id, 'after', file)); }
		const evidence = await measure('validation-candidate', () => store.prepareValidation(review.id, review.digest));
		const result = await measure('host-validation', async () => runProposalValidation(store, evidence, await validationCommands(evidence.workspace)));
		assert.equal(result.status, 'passed');
		await measure('apply', () => store.apply(review.id, review.digest, undefined, result.id));
	}
	await assert.rejects(store.apply(reviews[2].id, reviews[2].digest), /conflict/);
	await writeFile(path.join(workspace, 'user-notes.txt'), 'Later user edit retained.\n');
	await measure('restore-last-application', () => store.restoreLastApplication(reviews[1].id));
	assert.equal(await readFile(path.join(workspace, 'user-notes.txt'), 'utf8'), 'Later user edit retained.\n');
	assert.match(await readFile(path.join(workspace, 'src/clamp.js'), 'utf8'), /inverted bounds/);
	assert.equal(git('diff', '--cached'), '');
	// Optional live probe uses a supplied adapter definition, never provider credentials in a report.
	if (process.env.SOTA_BENCHMARK_AGENT) {
		const definition = JSON.parse(await readFile(process.env.SOTA_BENCHMARK_AGENT));
		const { AcpRuntime } = require('../son-of-anton-core/dist/acp/AcpRuntime');
		const runtime = new AcpRuntime({ maxProcesses: 1 }); let textChunks = 0, permissionRequests = 0;
		const proposal = await store.create(workspace), started = performance.now();
		try {
			const response = await runtime.run({ agent: definition, cwd: proposal.worktree, conversationId: 'scale-live', timeoutMs: 180_000,
				text: 'This is a disposable IDE verification workspace. Read src/clamp.js, src/sum.js and the test folder. Add test/live-clamp.test.js using node:test and node:assert/strict to cover both lower and upper clamp boundaries. Do not modify any other files, do not install dependencies, access credentials, contact external services, or commit. Run npm run build, then npm test. Briefly report your result.',
				onUpdate: update => { if (update.sessionUpdate === 'agent_message_chunk') { textChunks++; } },
				onPermission: async request => { permissionRequests++; const option = request.options.find(option => option.kind === 'allow_once'); return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } }; },
			});
			assert.equal(response.stopReason, 'end_turn'); assert.ok(textChunks);
			const review = await store.finish(proposal.id, 'review'); assert.deepEqual(review.files, ['test/live-clamp.test.js']);
			const evidence = await store.prepareValidation(review.id, review.digest), result = await runProposalValidation(store, evidence, await validationCommands(evidence.workspace)); assert.equal(result.status, 'passed');
			live = { adapter: definition.id, durationMs: performance.now() - started, textChunks, permissionRequests, changedFiles: review.files, hostValidation: result.status };
		} finally { await runtime.shutdown(); }
	}
	const report = { version: 1, fixture: 'multi-file-workflow', sourceFiles: sourceFiles + 2, coordination: 'deterministic competing agent outputs', scenarios: ['dirty-workspace-preserved', 'two-disjoint-multi-file-proposals', 'host-build-and-tests', 'conflicting-proposal-rejected', 'cancelled-work-retained-on-restart', 'targeted-restore-preserves-unrelated-edits'], samples, controllerPeakRssBytes: process.resourceUsage().maxRSS * 1024, controllerHeapUsedBytes: process.memoryUsage().heapUsed, live: live ?? null };
	const output = process.env.SOTA_BENCHMARK_OUTPUT || path.join(root, '.build/workflow-benchmark.json'); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
