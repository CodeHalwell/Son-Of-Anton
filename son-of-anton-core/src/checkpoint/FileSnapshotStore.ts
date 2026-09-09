/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface FileSnapshot {
	readonly version: 1;
	readonly id: string;
	readonly workspaceRoot: string;
	readonly rootIdentity: string;
	readonly storageRoot: string;
}
interface Entry { file: string; digest: string; mode: number; size: number }
interface Manifest { snapshot: FileSnapshot; files: Entry[] }
const EXCLUDED = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', '__pycache__', '.DS_Store']);
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 10000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function sameFile(left: Stats, right: Stats): boolean {
	return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/** Complete bounded snapshots for scratch folders. Dependencies and VCS internals are explicitly outside their scope. */
export class FileSnapshotStore {
	private static readonly locks = new Map<string, Promise<void>>();
	constructor(private readonly root: string, private readonly storage: string) {}
	private directory(snapshot: FileSnapshot): string { return path.join(this.storage, createHash('sha256').update(snapshot.workspaceRoot).digest('hex'), snapshot.id); }
	private async identity(): Promise<{ workspaceRoot: string; rootIdentity: string; storageRoot: string }> {
		const workspaceRoot = await fs.realpath(this.root); const stat = await fs.stat(workspaceRoot);
		if (!stat.isDirectory()) { throw new Error('Checkpoint workspace is not a directory.'); }
		await fs.mkdir(this.storage, { recursive: true, mode: 0o700 }); const storageRoot = await fs.realpath(this.storage);
		if (storageRoot === workspaceRoot || storageRoot.startsWith(`${workspaceRoot}${path.sep}`)) { throw new Error('Checkpoint storage must be outside the workspace.'); }
		try { await fs.lstat(path.join(workspaceRoot, '.git')); throw new Error('Workspace now has Git metadata. Capture a Git checkpoint instead.'); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
		return { workspaceRoot, rootIdentity: `${stat.dev}:${stat.ino}`, storageRoot };
	}
	private async readWorkspace(root = this.root): Promise<{ files: Entry[]; bodies: Map<string, Buffer> }> {
		const files: Entry[] = []; const bodies = new Map<string, Buffer>(); let bytes = 0;
		const visit = async (folder: string): Promise<void> => {
			for (const child of await fs.readdir(path.join(root, folder), { withFileTypes: true })) {
				if (EXCLUDED.has(child.name)) { continue; }
				const file = folder ? `${folder}/${child.name}` : child.name;
				const full = path.join(root, file);
				if (child.isSymbolicLink()) { throw new Error(`File checkpoints do not follow symbolic links: ${file}`); }
				if (child.isDirectory()) {
					const before = await fs.lstat(full);
					if (!before.isDirectory()) { throw new Error(`Directory changed while capturing checkpoint: ${file}`); }
					await visit(file);
					const after = await fs.lstat(full);
					if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) { throw new Error(`Directory changed while capturing checkpoint: ${file}`); }
					continue;
				}
				// Open first, then inspect the descriptor. NOFOLLOW rejects a substituted
				// symlink; NONBLOCK avoids hanging if a regular entry becomes a FIFO.
				const handle = await fs.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
				try {
					const before = await handle.stat();
					if (!before.isFile()) { throw new Error(`Unsupported checkpoint file type: ${file}`); }
					if (!sameFile(before, await fs.lstat(full))) { throw new Error(`File changed while capturing checkpoint: ${file}`); }
					if (before.size > MAX_BYTES - bytes || files.length >= MAX_FILES) { throw new Error('File checkpoint exceeds 50 MiB or 10,000 files; nothing was partially captured.'); }
					// Bound allocation and reads by the inspected size, even if a concurrent
					// writer grows the file. A short read or extra byte invalidates capture.
					const body = Buffer.allocUnsafe(before.size); let offset = 0;
					while (offset < body.length) {
						const read = await handle.read(body, offset, body.length - offset, offset);
						if (!read.bytesRead) { throw new Error(`File changed while capturing checkpoint: ${file}`); }
						offset += read.bytesRead;
					}
					const tail = await handle.read(Buffer.allocUnsafe(1), 0, 1, body.length);
					if (tail.bytesRead || !sameFile(before, await handle.stat()) || !sameFile(before, await fs.lstat(full))) { throw new Error(`File changed while capturing checkpoint: ${file}`); }
					bytes += body.length;
					const digest = createHash('sha256').update(body).digest('hex'); bodies.set(digest, body);
					files.push({ file, digest, mode: before.mode & 0o777, size: body.length });
				} finally { await handle.close(); }
			}
		};
		await visit(''); files.sort((a, b) => a.file.localeCompare(b.file)); return { files, bodies };
	}
	async capture(): Promise<FileSnapshot> {
		const identity = await this.identity(); const { files, bodies } = await this.readWorkspace(identity.workspaceRoot);
		const snapshot: FileSnapshot = { version: 1, id: randomUUID(), ...identity }; const directory = this.directory(snapshot);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		try {
			for (const [digest, body] of bodies) { await fs.writeFile(path.join(directory, digest), body, { flag: 'wx', mode: 0o600 }); }
			await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ snapshot, files } satisfies Manifest), { flag: 'wx', mode: 0o600 });
			return snapshot;
		} catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
	}
	private async validate(snapshot: FileSnapshot): Promise<Manifest> {
		const identity = await this.identity();
		if (snapshot.version !== 1 || !UUID.test(snapshot.id) || snapshot.workspaceRoot !== identity.workspaceRoot || snapshot.rootIdentity !== identity.rootIdentity || snapshot.storageRoot !== identity.storageRoot) { throw new Error('File checkpoint belongs to a different workspace or storage location.'); }
		const manifest = JSON.parse(await fs.readFile(path.join(this.directory(snapshot), 'manifest.json'), 'utf8')) as Manifest;
		if (JSON.stringify(manifest.snapshot) !== JSON.stringify(snapshot) || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) { throw new Error('Invalid file checkpoint manifest.'); }
		const seen = new Set<string>(); let bytes = 0;
		for (const entry of manifest.files) {
			if (!entry.file || entry.file.includes('\\') || path.isAbsolute(entry.file) || entry.file.split('/').some(part => !part || part === '.' || part === '..' || EXCLUDED.has(part)) || seen.has(entry.file) || !/^[a-f0-9]{64}$/.test(entry.digest) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !Number.isInteger(entry.size) || entry.size < 0 || (bytes += entry.size) > MAX_BYTES) { throw new Error('Unsafe file checkpoint entry.'); }
			seen.add(entry.file);
			const body = await fs.readFile(path.join(this.directory(snapshot), entry.digest));
			if (body.length !== entry.size || createHash('sha256').update(body).digest('hex') !== entry.digest) { throw new Error(`Checkpoint content is damaged: ${entry.file}`); }
		}
		return manifest;
	}
	private changed(target: Manifest, current: Manifest): string[] {
		const before = new Map(current.files.map(file => [file.file, file])); const after = new Map(target.files.map(file => [file.file, file]));
		return [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file)?.digest !== after.get(file)?.digest || before.get(file)?.mode !== after.get(file)?.mode).sort();
	}
	/**
	 * Preview and recheck edits before restoring. A host may durably retain recovery
	 * before mutation; markRetained must run at that commit even if later work fails.
	 */
	async restore(snapshot: FileSnapshot, confirm: (files: readonly string[]) => Promise<boolean>, retainRecovery?: (recovery: FileSnapshot, markRetained: () => void) => Promise<void>): Promise<FileSnapshot | undefined> {
		const key = (await this.identity()).workspaceRoot; const previous = FileSnapshotStore.locks.get(key) ?? Promise.resolve();
		let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
		const queued = previous.then(() => gate); FileSnapshotStore.locks.set(key, queued); await previous;
		try {
			const target = await this.validate(snapshot); const recovery = await this.capture(); const before = await this.validate(recovery); let mutationStarted = false; let recoveryRetained = false; let restoreFailure: unknown;
			try {
				const files = this.changed(target, before); if (!await confirm(files)) { return undefined; }
				// A host must make the pre-restore snapshot reachable before files change.
				// Recheck the workspace after that asynchronous persistence boundary.
				if (retainRecovery) { await retainRecovery(recovery, () => { recoveryRetained = true; }); recoveryRetained = true; }
				const current = await this.readWorkspace(snapshot.workspaceRoot);
				if (this.changed(before, { snapshot: recovery, files: current.files }).length) { throw new Error('Files changed while confirming. Review the checkpoint again before restoring.'); }
				await this.validate(snapshot);
				// Validate all ancestor paths before the first destructive operation.
				for (const file of files) { await this.verifyAncestors(file, snapshot.workspaceRoot); }
				mutationStarted = true;
				try { await this.apply(target, before); }
				catch (error) {
					try { await this.apply(before, { snapshot: recovery, files: (await this.readWorkspace(snapshot.workspaceRoot)).files }); }
					catch { throw new Error(`Restore and rollback failed. Recovery files are retained at ${this.directory(recovery)}.`, { cause: error }); }
					throw new Error(`Restore failed; the previous files were recovered. Recovery: ${this.directory(recovery)}`, { cause: error });
				}
				return recovery;
			} catch (error) { restoreFailure = error; throw error; }
			finally {
				if (!mutationStarted && !recoveryRetained) {
					try { await this.release(recovery); }
					catch (cleanupError) {
						if (restoreFailure) { throw new AggregateError([restoreFailure, cleanupError], `${restoreFailure instanceof Error ? restoreFailure.message : String(restoreFailure)} Unused recovery files could not be removed from ${this.directory(recovery)}.`, { cause: restoreFailure }); }
						throw cleanupError;
					}
				}
			}
		} finally { release(); if (FileSnapshotStore.locks.get(key) === queued) { FileSnapshotStore.locks.delete(key); } }
	}
	private async verifyAncestors(file: string, root: string): Promise<void> {
		const parts = file.split('/'); let parent = root;
		for (const part of parts.slice(0, -1)) {
			parent = path.join(parent, part);
			try { if ((await fs.lstat(parent)).isSymbolicLink()) { throw new Error(`Restore path contains a symbolic link: ${file}`); } }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') { throw error; } }
		}
	}
	private async apply(target: Manifest, current: Manifest): Promise<void> {
		const root = target.snapshot.workspaceRoot;
		const targetFiles = new Map(target.files.map(file => [file.file, file]));
		for (const entry of [...current.files].sort((a, b) => b.file.length - a.file.length)) {
			if (!targetFiles.has(entry.file)) { await this.verifyAncestors(entry.file, root); await fs.unlink(path.join(root, entry.file)); }
		}
		for (const entry of target.files) {
			const existing = current.files.find(file => file.file === entry.file);
			if (existing?.digest === entry.digest && existing.mode === entry.mode) { continue; }
			await this.verifyAncestors(entry.file, root); const full = path.join(root, entry.file);
			try { if ((await fs.lstat(full)).isDirectory()) { await this.removeEmptyDirectories(full); } }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
			await fs.mkdir(path.dirname(full), { recursive: true });
			const temporary = path.join(path.dirname(full), `.sota-restore-${randomUUID()}`);
			try {
				await fs.copyFile(path.join(this.directory(target.snapshot), entry.digest), temporary, fs.constants.COPYFILE_EXCL);
				await fs.chmod(temporary, entry.mode); await fs.rename(temporary, full);
			} finally { await fs.rm(temporary, { force: true }); }
		}
	}
	private async removeEmptyDirectories(directory: string): Promise<void> {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || EXCLUDED.has(entry.name)) { throw new Error('Restore would overwrite an excluded or newly created file.'); }
			await this.removeEmptyDirectories(path.join(directory, entry.name));
		}
		await fs.rmdir(directory);
	}
	async release(snapshot: FileSnapshot): Promise<void> {
		if (!UUID.test(snapshot.id) || await fs.realpath(this.storage) !== snapshot.storageRoot) { throw new Error('Invalid file checkpoint location.'); }
		await fs.rm(this.directory(snapshot), { recursive: true, force: true });
	}
}
