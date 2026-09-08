/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, chmod, realpath, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { join, relative, isAbsolute, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { x as extractTar } from 'tar';
import { open as openZip, type Entry, type ZipFile } from 'yauzl';
import { object, type AcpAgentDefinition } from '../acp/protocol';
import { readBoundedFile } from '../util/readBoundedFile';

export const ACP_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
interface PackageDistribution { package: string; args?: string[]; env?: Record<string, string> }
interface BinaryDistribution { archive: string; cmd: string; sha256?: string; args?: string[]; env?: Record<string, string> }
export interface RegistryAgent { id: string; name: string; version: string; description?: string; repository?: string; distribution: { npx?: PackageDistribution; uvx?: PackageDistribution; binary?: Record<string, BinaryDistribution> } }
export interface RegistryCatalog { version: string; agents: RegistryAgent[] }
export interface RegistryPlan { agent: RegistryAgent; kind: 'npx' | 'uvx' | 'binary'; package?: string; archive?: string; sha256?: string; launch?: AcpAgentDefinition }
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,100}$/;
function httpsUrl(value: string): URL { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) { throw new Error('Registry downloads require HTTPS without URL credentials'); } return url; }
function invocation(value: PackageDistribution | BinaryDistribution): void {
	if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > 64 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096))) { throw new Error('Invalid registry arguments'); }
	if (value.env !== undefined && (!object(value.env) || Object.entries(value.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 4096))) { throw new Error('Invalid registry environment'); }
}
export function parseRegistry(text: string): RegistryCatalog {
	if (Buffer.byteLength(text) > 4 * 1024 * 1024) { throw new Error('ACP registry exceeds 4 MiB'); }
	const catalog = JSON.parse(text) as RegistryCatalog;
	if (!catalog || typeof catalog.version !== 'string' || !Array.isArray(catalog.agents) || catalog.agents.length > 1000) { throw new Error('Invalid ACP registry'); }
	const ids = new Set<string>();
	for (const agent of catalog.agents) {
		if (!agent || !ID.test(agent.id) || ids.has(agent.id) || typeof agent.name !== 'string' || agent.name.length > 200 || typeof agent.version !== 'string' || agent.version.length > 128 || !object(agent.distribution)) { throw new Error('Invalid or duplicate ACP registry entry'); }
		ids.add(agent.id);
		for (const distribution of [agent.distribution.npx, agent.distribution.uvx]) { if (distribution) { if (!object(distribution) || typeof distribution.package !== 'string') { throw new Error('Invalid package distribution'); } invocation(distribution); } }
		if (agent.distribution.binary) { if (!object(agent.distribution.binary)) { throw new Error('Invalid binary distribution'); } for (const binary of Object.values(agent.distribution.binary)) { if (!binary || typeof binary.archive !== 'string' || typeof binary.cmd !== 'string') { throw new Error('Invalid binary'); } httpsUrl(binary.archive); archivePath(binary.cmd.replace(/\\/g, '/')); invocation(binary); if (binary.sha256 && !/^[a-f0-9]{64}$/i.test(binary.sha256)) { throw new Error('Invalid archive checksum'); } } }
	}
	return catalog;
}
async function download(url: string, limit: number, fetcher: typeof fetch): Promise<Buffer> {
	let current = httpsUrl(url); const signal = AbortSignal.timeout(60_000);
	for (let redirects = 0; redirects <= 5; redirects++) {
		const response = await fetcher(current, { redirect: 'manual', signal });
		if (response.status >= 300 && response.status < 400 && response.headers.get('location')) { await response.body?.cancel(); current = httpsUrl(new URL(response.headers.get('location')!, current).href); continue; }
		if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Registry download failed (${response.status})`); }
		const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
		try { while (true) { const part = await reader.read(); if (part.done) { return Buffer.concat(chunks); } size += part.value.length; if (size > limit) { throw new Error('Registry download exceeded its byte limit'); } chunks.push(part.value); } }
		finally { await reader.cancel(); }
	}
	throw new Error('Registry download exceeded redirect limit');
}
/** Registry path entries never become shell commands or escape the fresh extraction directory. */
export function archivePath(value: string): string {
	const clean = value.replace(/^\.\//, '');
	if (!clean || clean.includes('\\') || clean.includes('\0') || clean.includes(':') || isAbsolute(clean) || clean.split('/').some(part => part === '..')) { throw new Error('Unsafe archive path'); }
	return clean;
}
async function extractZip(file: string, directory: string): Promise<void> {
	const zip = await new Promise<ZipFile>((resolve, reject) => openZip(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, result) => error || !result ? reject(error) : resolve(result)));
	let bytes = 0; let count = 0; const names = new Set<string>();
	const controller = new AbortController();
	let pending = Promise.resolve();
	const timer = setTimeout(() => controller.abort(new Error('Archive extraction timed out')), 60_000);
	try { await new Promise<void>((resolve, reject) => {
		const fail = (error: Error) => { controller.abort(error); reject(error); };
		controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
		zip.on('error', fail); zip.on('end', resolve);
		zip.on('entry', (entry: Entry) => { pending = (async () => {
			controller.signal.throwIfAborted();
			const name = archivePath(entry.fileName); const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
			bytes += entry.uncompressedSize; if (++count > 10_000 || bytes > 256 * 1024 * 1024 || names.has(name) || (kind && kind !== 0o100000 && kind !== 0o040000)) { throw new Error('Unsafe archive type, duplicate path, or expanded-size limit'); } names.add(name);
			const target = join(directory, name);
			if (name.endsWith('/')) { await mkdir(target, { recursive: true }); }
			else { await mkdir(dirname(target), { recursive: true }); const stream = await new Promise<NodeJS.ReadableStream>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error || !stream ? reject(error) : resolve(stream))); await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal: controller.signal }); }
			zip.readEntry();
		})().catch(fail); }); zip.readEntry();
	}); } finally { clearTimeout(timer); controller.abort(); await pending; zip.close(); }
}

/** Fetching metadata never installs or starts an adapter. Binary installation verifies before extraction. */
export class AcpRegistry {
	constructor(readonly directory: string, private readonly fetcher: typeof fetch = fetch) {}
	async catalog(refresh = false): Promise<RegistryCatalog> {
		const file = join(this.directory, 'registry.json');
		if (!refresh) { try { const { content, info } = await readBoundedFile(file, 4 * 1024 * 1024); if (Date.now() - info.mtimeMs < 86_400_000) { return parseRegistry(content); } } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } } }
		const data = await download(ACP_REGISTRY_URL, 4 * 1024 * 1024, this.fetcher); const catalog = parseRegistry(data.toString('utf8')); await mkdir(this.directory, { recursive: true, mode: 0o700 }); const temp = `${file}.${randomUUID()}.tmp`; try { await writeFile(temp, data, { mode: 0o600 }); await rename(temp, file); } finally { await rm(temp, { force: true }); } return catalog;
	}
	async plan(id: string): Promise<RegistryPlan> {
		const agent = (await this.catalog()).agents.find(agent => agent.id === id); if (!agent) { throw new Error('Unknown registry agent'); }
		for (const kind of ['npx', 'uvx'] as const) {
			const distribution = agent.distribution[kind]; if (!distribution) { continue; }
			const expression = kind === 'npx' ? /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)(?:@([^@]+))?$/i : /^([a-z0-9._-]+)(?:==([^=]+))?$/i;
			const match = expression.exec(distribution.package); if (!match || !VERSION.test(match[2] ?? agent.version)) { throw new Error('ACP packages must use an exact release version'); }
			const pinned = `${match[1]}${kind === 'npx' ? '@' : '=='}${match[2] ?? agent.version}`;
			return { agent, kind, package: pinned, launch: { id: agent.id, command: kind === 'npx' && process.platform === 'win32' ? 'npx.cmd' : kind, args: [...(kind === 'npx' ? ['--yes'] : []), pinned, ...(distribution.args ?? [])], env: distribution.env } };
		}
		const binary = this.binary(agent); if (!binary.sha256) { throw new Error('Binary adapter has no registry checksum; installation is unavailable.'); }
		return { agent, kind: 'binary', archive: binary.archive, sha256: binary.sha256 };
	}
	private binary(agent: RegistryAgent): BinaryDistribution {
		const platform = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`;
		const distribution = agent.distribution.binary?.[platform]; if (!distribution) { throw new Error(`No binary adapter for ${platform}`); } return distribution;
	}
	async installBinary(id: string): Promise<AcpAgentDefinition> {
		const plan = await this.plan(id); if (plan.kind !== 'binary') { throw new Error('Package adapters are configured for installation by their runner on first use.'); }
		const binary = this.binary(plan.agent); const target = join(this.directory, 'installed', plan.agent.id, createHash('sha256').update(JSON.stringify(binary)).digest('hex').slice(0, 24));
		const command = archivePath(binary.cmd.replace(/\\/g, '/'));
		const launch = (): AcpAgentDefinition => ({ id, command: join(target, command), args: binary.args ?? [], env: binary.env });
		try { const marker = await readFile(join(target, '.sota-verified'), 'utf8'); if (marker === plan.sha256 && (await stat(join(target, command))).isFile()) { return launch(); } } catch { /* a missing or incomplete installation is rebuilt in isolation */ }
		const data = await download(binary.archive, 128 * 1024 * 1024, this.fetcher);
		if (createHash('sha256').update(data).digest('hex') !== plan.sha256?.toLowerCase()) { throw new Error('ACP archive checksum mismatch'); }
		await mkdir(dirname(target), { recursive: true, mode: 0o700 }); const staging = await mkdtemp(join(dirname(target), '.install-'));
		try {
			const archive = join(staging, 'download'); const payload = join(staging, 'payload'); await writeFile(archive, data, { mode: 0o600 }); await mkdir(payload);
			if (new URL(binary.archive).pathname.endsWith('.zip')) { await extractZip(archive, payload); }
			else {
				let count = 0; let bytes = 0; const names = new Set<string>(); let invalid: Error | undefined;
				const unpack = extractTar({ cwd: payload, strict: true, preservePaths: false, maxMetaEntrySize: 1024 * 1024, filter: (name, entry) => {
					try { if (('type' in entry && entry.type === 'Directory') && (name === '.' || name === './')) { return true; } const safe = archivePath(name); bytes += entry.size; if (++count > 10_000 || bytes > 256 * 1024 * 1024 || names.has(safe) || !('type' in entry && ['File', 'OldFile', 'Directory'].includes(entry.type))) { throw new Error('Unsafe archive type, duplicate path, or expanded-size limit'); } names.add(safe); return true; } catch (error) { invalid = error as Error; return false; }
				} });
				let expanded = 0;
				const limit = new Transform({ transform(chunk: Buffer, _encoding, done) { expanded += chunk.length; done(expanded > 300 * 1024 * 1024 ? new Error('Expanded archive exceeded byte limit') : null, chunk); } });
				await pipeline(createReadStream(archive), data[0] === 0x1f && data[1] === 0x8b ? createGunzip() : new PassThrough(), limit, unpack, { signal: AbortSignal.timeout(60_000) });
				if (invalid) { throw invalid; }
			}
			const executable = await realpath(join(payload, command)); const rel = relative(await realpath(payload), executable); if (rel.startsWith('..') || isAbsolute(rel) || !(await stat(executable)).isFile()) { throw new Error('Registry executable is outside the archive'); }
			await chmod(executable, 0o755); await writeFile(join(payload, '.sota-verified'), plan.sha256!, { mode: 0o600 }); await rename(payload, target); return launch();
		} finally { await rm(staging, { recursive: true, force: true }); }
	}
}
