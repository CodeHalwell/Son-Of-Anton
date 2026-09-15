/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureServices } from '../configure-services.mjs';

test('service configuration has independent private credentials and refuses replacement', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'sota-service-setup-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, '.env');
	await configureServices(file);
	const original = await readFile(file, 'utf8');
	const secrets = [...original.matchAll(/^(SOTA_SERVICE_TOKEN|FALKORDB_PASSWORD|QDRANT_API_KEY|BACKGROUND_TASK_API_TOKEN|DB_PASSWORD|POSTGRES_ADMIN_PASSWORD)=([a-f0-9]{64})$/gm)].map(match => match[2]);
	assert.equal(new Set(secrets).size, 6);
	assert.ok(!original.includes('dev-insecure-'));
	assert.match(original, /^ANTHROPIC_API_KEY=$/m);
	if (process.platform !== 'win32') { assert.equal((await stat(file)).mode & 0o777, 0o600); }
	await assert.rejects(configureServices(file), { code: 'EEXIST' });
	assert.equal(await readFile(file, 'utf8'), original);
	const second = join(directory, 'second.env'); await configureServices(second);
	assert.notEqual(await readFile(second, 'utf8'), original);
});

test('configuration creation cannot replace a symlink target', { skip: process.platform === 'win32' }, async t => {
	const directory = await mkdtemp(join(tmpdir(), 'sota-service-link-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const target = join(directory, 'target.env'); await configureServices(target);
	const original = await readFile(target, 'utf8');
	const link = join(directory, '.env'); await symlink(target, link);
	await assert.rejects(configureServices(link), { code: 'EEXIST' });
	assert.equal(await readFile(target, 'utf8'), original);
});

test('Compose rejects missing credentials and preserves authenticated datastore configuration', async t => {
	const { spawnSync } = await import('node:child_process');
	const { fileURLToPath } = await import('node:url');
	if (spawnSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10000 }).status !== 0) { t.skip('Docker Compose is not installed'); return; }
	const directory = await mkdtemp(join(tmpdir(), 'sota-compose-config-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const root = fileURLToPath(new URL('../../', import.meta.url));
	const file = join(directory, '.env'); await configureServices(file);
	const env = { ...process.env, SOTA_ENV_FILE: file };
	for (const key of ['SOTA_SERVICE_TOKEN', 'FALKORDB_PASSWORD', 'QDRANT_API_KEY', 'BACKGROUND_TASK_API_TOKEN', 'DB_PASSWORD', 'POSTGRES_ADMIN_PASSWORD', 'COMPOSE_FILE']) { delete env[key]; }
	const check = envFile => spawnSync('docker', ['compose', '--env-file', envFile, '-f', join(root, 'docker-compose.yml'), '--profile', 'services', 'config', '--format', 'json'], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
	const missing = check(join(root, '.env.example'));
	assert.notEqual(missing.status, 0, 'Blank credentials must prevent startup');
	const configured = check(file);
	assert.equal(configured.status, 0, 'Generated configuration must be accepted by Compose');
	const services = JSON.parse(configured.stdout).services;
	assert.ok(services.indexer.environment.LANGUAGES.split(',').includes('javascript'));
	assert.ok(services.indexer.environment.LANGUAGES.split(',').includes('tsx'));
	assert.ok(Object.keys(services['background-tasks'].networks).some(network => network in services['mcp-gateway'].networks), 'Background tasks must be able to reach their gateway');
	assert.equal(services.postgres.environment.POSTGRES_HOST_AUTH_METHOD, undefined);
	assert.equal(services.postgres.environment.POSTGRES_INITDB_ARGS, '--auth-host=scram-sha-256');
	assert.match(services.postgres.environment.POSTGRES_PASSWORD, /^[a-f0-9]{64}$/);
	assert.notEqual(services.postgres.environment.POSTGRES_PASSWORD, services['mcp-database'].environment.DB_PASSWORD);
	assert.equal(services.postgres.environment.DB_PASSWORD, services['mcp-database'].environment.DB_PASSWORD);
	assert.equal(services.postgres.environment.POSTGRES_USER, 'sota_admin');
	assert.equal(services['mcp-database'].environment.DB_USER, 'readonly');
	assert.ok(services.postgres.volumes.some(volume => volume.type === 'volume' && volume.source === 'postgres-data'));
	assert.ok(services.falkordb.environment.REDIS_ARGS.startsWith('--requirepass '));
	assert.ok(!services.falkordb.healthcheck.test.join(' ').includes('NOAUTH'));
	assert.match(services.qdrant.environment.QDRANT__SERVICE__API_KEY, /^[a-f0-9]{64}$/);
	for (const service of Object.values(services)) {
		for (const port of service.ports || []) { assert.equal(port.host_ip, '127.0.0.1'); }
	}
});
