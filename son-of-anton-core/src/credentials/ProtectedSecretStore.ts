/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SecretStore } from '../host';
import { readBoundedFile } from '../util/readBoundedFile';

interface CommandResult { code: number; stdout: string }
export type SecretCommand = (command: string, args: string[], input?: string) => Promise<CommandResult>;

const run: SecretCommand = (command, args, input) => new Promise((resolve, reject) => {
	const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
	let stdout = '';
	const timer = setTimeout(() => { child.kill(); reject(new Error('Protected credential store timed out')); }, 15000);
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		stdout += chunk;
		if (stdout.length > 1024 * 1024) { child.kill(); reject(new Error('Protected credential response too large')); }
	});
	child.once('error', () => { clearTimeout(timer); reject(new Error('Protected credential store unavailable. Install secret-tool on Linux, or provide credentials through environment variables.')); });
	child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
	child.stdin.on('error', () => { /* Child exit is handled above. */ });
	child.stdin.end(input);
});

const SERVICE = 'com.son-of-anton.credentials';
const queues = new Map<string, Promise<void>>();

/** Shared IDE/CLI storage: Keychain on macOS, Secret Service on Linux, DPAPI on Windows. */
export class ProtectedSecretStore implements SecretStore {
	constructor(private readonly execute: SecretCommand = run, private readonly platform: NodeJS.Platform = process.platform, private readonly directory = path.join(os.homedir(), '.son-of-anton/data/protected-secrets')) { }

	private account(key: string): string { return Buffer.from(key).toString('base64url'); }
	// This hashes a storage identifier (for example sota.secrets.anthropicApiKey), never a password or credential value.
	private file(key: string): string { return path.join(this.directory, createHash('sha256').update(key).digest('hex') + '.dpapi'); }
	private async serialize(key: string, operation: () => Promise<void>): Promise<void> {
		const id = `${this.platform}:${this.directory}:${key}`;
		const pending = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
		queues.set(id, pending);
		try { await pending; } finally { if (queues.get(id) === pending) { queues.delete(id); } }
	}

	async get(key: string): Promise<string | undefined> {
		let result: CommandResult;
		if (this.platform === 'darwin') {
			result = await this.execute('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', this.account(key), '-w']);
			if (result.code === 44) { return undefined; }
		} else if (this.platform === 'linux') {
			result = await this.execute('secret-tool', ['lookup', 'service', SERVICE, 'account', this.account(key)]);
			if (result.code === 1) { return undefined; }
		} else if (this.platform === 'win32') {
			let encrypted: string;
			try { encrypted = await fs.readFile(this.file(key), 'utf8'); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
			result = await this.dpapi('Unprotect', encrypted);
		} else { throw new Error('Protected credential storage is unsupported on this platform. Use environment variables.'); }
		if (result.code !== 0) { throw new Error('Protected credential store could not read the credential'); }
		return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
	}

	async store(key: string, value: string): Promise<void> {
		if (!key) { throw new Error('Credential key must not be empty'); }
		if (!value) { await this.delete(key); return; }
		await this.serialize(key, async () => {
			const encoded = Buffer.from(value).toString('base64');
			let result: CommandResult;
			if (this.platform === 'darwin') {
				// Interactive commands arrive on stdin. Neither the credential nor
				// its encoding appears in argv, shell expansion, or diagnostic logs.
				result = await this.execute('/usr/bin/security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${this.account(key)} -w ${encoded}\n`);
			} else if (this.platform === 'linux') {
				result = await this.execute('secret-tool', ['store', '--label=Son of Anton', 'service', SERVICE, 'account', this.account(key)], encoded);
			} else if (this.platform === 'win32') {
				result = await this.dpapi('Protect', encoded);
				if (result.code === 0) {
					await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
					await atomicWrite(this.file(key), result.stdout.trim());
				}
			} else { throw new Error('Protected credential storage is unsupported. Use environment variables.'); }
			if (result.code !== 0 || await this.get(key) !== value) { throw new Error('Protected credential save could not be verified'); }
		});
	}

	async delete(key: string): Promise<void> {
		await this.serialize(key, async () => {
			let result: CommandResult;
			if (this.platform === 'darwin') {
				result = await this.execute('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', this.account(key)]);
				if (result.code === 44) { return; }
			} else if (this.platform === 'linux') {
				result = await this.execute('secret-tool', ['clear', 'service', SERVICE, 'account', this.account(key)]);
				if (result.code === 1) { return; }
			} else if (this.platform === 'win32') {
				await fs.unlink(this.file(key)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } });
				return;
			} else { return; }
			if (result.code !== 0) { throw new Error('Protected credential deletion failed'); }
		});
	}

	private dpapi(operation: 'Protect' | 'Unprotect', input: string): Promise<CommandResult> {
		const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
		return this.execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], input);
	}

	/** Explicit migration keeps the old file until every protected save is verified. */
	async migrateLegacy(file: string): Promise<number> {
		const original = await readBoundedFile(file, 1024 * 1024, true);
		const values = JSON.parse(original.content) as Record<string, string>;
		if (!values || Array.isArray(values) || typeof values !== 'object' || Object.values(values).some(value => typeof value !== 'string')) { throw new Error('Invalid legacy credential file'); }
		for (const [key, value] of Object.entries(values)) { if (await this.get(key) === undefined) { await this.store(key, value); } }
		// Claim the pathname atomically before checking what would be deleted. A concurrent
		// writer can recreate the original pathname without its new file being removed.
		const directory = await fs.mkdtemp(path.join(path.dirname(file), '.sota-credential-migration-'));
		const claimed = path.join(directory, 'secrets.json');
		let retained = false;
		try {
			await fs.rename(file, claimed); retained = true;
			const current = await readBoundedFile(claimed, 1024 * 1024, true);
			if (current.info.dev !== original.info.dev || current.info.ino !== original.info.ino || current.content !== original.content) { throw new Error('Legacy credentials changed during migration; retry after closing older IDE instances'); }
			await fs.unlink(claimed); retained = false;
		} catch (error) {
			if (retained) {
				try { await fs.link(claimed, file); await fs.unlink(claimed); retained = false; }
				catch { throw new Error(`Legacy credentials were retained at ${claimed}. The original path changed; restore or migrate this retained file after closing older IDE instances.`, { cause: error }); }
			}
			throw error;
		} finally { if (!retained) { await fs.rmdir(directory); } }
		return Object.keys(values).length;
	}
}

async function atomicWrite(file: string, content: string): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try { await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
	finally { await fs.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }); }
}
