/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

test('PostgreSQL reader authenticates, reads future tables, and cannot write or access server files', { skip: process.env.SOTA_TEST_DOCKER !== '1', timeout: 90000 }, async t => {
	const name = `sota-postgres-test-${randomUUID()}`;
	const directory = await mkdtemp(join(tmpdir(), 'sota-postgres-test-'));
	const docker = args => spawnSync('docker', args, { encoding: 'utf8', timeout: 15000 });
	t.after(async () => { docker(['rm', '-fv', name]); await rm(directory, { recursive: true, force: true }); });
	const envFile = join(directory, 'database.env');
	await writeFile(envFile, `POSTGRES_USER=sota_admin\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\nPOSTGRES_DB=sota_fixture\nPOSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\nDB_USER=readonly\nDB_PASSWORD=${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
	const init = fileURLToPath(new URL('../../services/postgres/init-readonly.sql', import.meta.url));
	assert.equal(docker(['run', '-d', '--name', name, '--network', 'none', '--memory', '256m', '--cpus', '1', '--env-file', envFile, '--mount', `type=bind,source=${init},target=/docker-entrypoint-initdb.d/10-readonly.sql,readonly`, 'postgres:16']).status, 0, 'Disposable PostgreSQL must start');
	const query = (role, sql) => docker(['exec', name, 'sh', '-c', role === 'admin'
		? 'PGPASSWORD="$POSTGRES_PASSWORD" psql -w -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -c "$1"'
		: 'PGPASSWORD="$DB_PASSWORD" psql -w -h 127.0.0.1 -U "$DB_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -c "$1"', 'sota-test', sql]);
	let ready = false;
	for (let attempt = 0; attempt < 80; attempt++) {
		if (query('reader', 'SELECT 1').status === 0) { ready = true; break; }
		await setTimeout(500);
	}
	assert.ok(ready, 'Reader must authenticate after database initialization');
	assert.equal(query('admin', 'CREATE TABLE public.fixture (id integer); INSERT INTO public.fixture VALUES (42);').status, 0);
	assert.equal(query('reader', 'SELECT id FROM public.fixture').stdout.trim(), '42');
	assert.equal(query('reader', 'SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user').stdout.trim(), 'f|f|f');
	assert.notEqual(query('reader', 'SET default_transaction_read_only = off; INSERT INTO public.fixture VALUES (99);').status, 0);
	assert.notEqual(query('reader', 'SELECT pg_read_file(\'/etc/passwd\')').status, 0);
	assert.equal(query('admin', 'SELECT count(*) FROM public.fixture').stdout.trim(), '1');
	const invalid = docker(['exec', '-e', 'PGPASSWORD=incorrect', name, 'psql', '-w', '-h', '127.0.0.1', '-U', 'readonly', '-d', 'sota_fixture', '-c', 'SELECT 1']);
	assert.notEqual(invalid.status, 0, 'Wrong credentials must be rejected over TCP');
});
