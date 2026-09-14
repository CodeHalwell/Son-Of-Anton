/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const { VisualRegressionService } = require('../dist/index.js');

function png(width = 8, height = 8, white = false) {
	const image = new PNG({ width, height });
	for (let i = 0; i < image.data.length; i += 4) { image.data.fill(white ? 255 : 0, i, i + 3); image.data[i + 3] = 255; }
	return PNG.sync.write(image);
}
async function fixture(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sota-visual-test-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const service = new VisualRegressionService(directory); await service.initialize();
	return { service, directory };
}
test('real PNG comparison detects changes and approval updates the baseline', async t => {
	const { service } = await fixture(t);
	assert.equal((await service.compare('home', png())).status, 'no_baseline');
	await service.saveBaseline('home', png());
	assert.equal((await service.compare('home', png())).status, 'passed');
	assert.equal((await service.compare('home', png(8, 8, true))).status, 'failed');
	assert.equal(await service.approveBaseline('home'), true);
	assert.equal((await service.compare('home', png(8, 8, true))).status, 'passed');
});
test('dimension changes can be approved and update metadata', async t => {
	const { service } = await fixture(t); await service.saveBaseline('home', png());
	const result = await service.compare('home', png(12, 10));
	assert.equal(result.status, 'dimension_mismatch');
	assert.equal(await service.approveBaseline('home'), true);
	const [metadata] = await service.listBaselines();
	assert.deepEqual([metadata.width, metadata.height], [12, 10]);
	assert.equal((await service.compare('home', png(12, 10))).status, 'passed');
});
test('invalid uploads leave the last good baseline intact', async t => {
	const { service } = await fixture(t); await service.saveBaseline('home', png());
	await assert.rejects(service.saveBaseline('home', Buffer.from('not a PNG')));
	assert.equal((await service.compare('home', png())).status, 'passed');
	const bomb = png(); bomb.writeUInt32BE(0xffffffff, 16);
	await assert.rejects(service.saveBaseline('home', bomb), /pixels/);
});
test('names cannot collide through sanitization or escape through directory and file links', async t => {
	const { service, directory } = await fixture(t);
	for (const name of ['', '../outside', 'a/b', 'a.b', 'x'.repeat(129)]) { await assert.rejects(service.saveBaseline(name, png()), /Name/); }
	if (process.platform === 'win32') { return; }
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sota-visual-outside-'));
	t.after(() => fs.rm(outside, { recursive: true, force: true }));
	await fs.symlink(outside, path.join(directory, 'linked'));
	await assert.rejects(service.saveBaseline('linked', png()), /Symlinks/);
	await service.saveBaseline('home', png());
	const target = path.join(outside, 'unchanged'); await fs.writeFile(target, 'keep');
	await fs.unlink(path.join(directory, 'home', 'baseline.png'));
	await fs.symlink(target, path.join(directory, 'home', 'baseline.png'));
	await assert.rejects(service.saveBaseline('home', png()), /Symlinks/);
	assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});
test('reports never describe missing, resized, or empty comparisons as all passed', async t => {
	const { service } = await fixture(t);
	const missing = await service.compare('missing', png());
	await service.saveBaseline('home', png());
	const resized = await service.compare('home', png(9, 9));
	for (const cases of [[], [missing], [resized], [missing, resized]]) {
		const report = await service.generateReport(cases); assert.doesNotMatch(report.summary, /All .* passed/);
	}
});

test('HTTP user flow authenticates, saves, compares, rejects malformed input, and recovers', { timeout: 20000 }, async t => {
	const { directory } = await fixture(t);
	const { spawn } = require('node:child_process');
	const { once } = require('node:events');
	const child = spawn(process.execPath, [path.resolve(__dirname, '../dist/index.js')], {
		env: { ...process.env, VISUAL_REGRESSION_PORT: '0', BASELINES_DIR: directory, SOTA_SERVICE_TOKEN: 'visual-test-token' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
	const port = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('Visual service startup timed out')), 10000);
		let output = '';
		child.stdout.on('data', chunk => { output += chunk; const match = output.match(/Listening on port (\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
		child.once('exit', code => { clearTimeout(timer); reject(new Error(`Visual service exited: ${code}`)); });
		child.once('error', error => { clearTimeout(timer); reject(error); });
	});
	const url = `http://127.0.0.1:${port}`;
	const post = (route, data) => fetch(url + route, { method: 'POST', headers: { Authorization: 'Bearer visual-test-token', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
	assert.equal((await fetch(url + '/health')).status, 200);
	assert.equal((await fetch(url + '/baselines')).status, 401);
	assert.equal((await post('/baselines', { name: 'home', imageData: png().toString('base64') })).status, 201);
	for (const data of [null, {}, { name: 'home', imageData: 1 }, { name: 'home', imageData: 'garbage' }, { name: '../outside', imageData: png().toString('base64') }]) {
		assert.equal((await post('/baselines', data)).status, 400);
	}
	assert.equal((await post('/report', { comparisons: null })).status, 400);
	assert.equal((await post('/approve', null)).status, 400);
	const comparison = await post('/compare', { name: 'home', imageData: png().toString('base64') });
	assert.equal(comparison.status, 200); assert.equal((await comparison.json()).status, 'passed');
});
