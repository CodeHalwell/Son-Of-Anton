/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import type { CouncilReport } from './types';

const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
export function renderCouncilMarkdown(report: CouncilReport): string {
	const sections = [`# ${report.group.name}\n\n${report.objective}`, `Status: **${report.status}**\n\nBase: ${report.snapshot.base}\n\nHEAD: ${report.snapshot.head}\n\nDiff SHA-256: ${report.snapshot.digest}`, report.snapshot.limitations.map(item => `- ${item}`).join('\n')];
	if (report.error) { sections.push(`Error: ${report.error}`); }
	for (const stage of report.stages) {
		sections.push(`## ${stage.member.label} · ${stage.kind} · round ${stage.round}\n\nStatus: ${stage.status}\n\nRoute: ${stage.member.acpAgent ? `ACP ${stage.member.acpAgent} (${stage.member.readOnlyMode})` : stage.member.model}\n\nUsage: ${stage.usage ? `${stage.usage.inputTokens} input / ${stage.usage.outputTokens} output tokens; billing unavailable` : 'unavailable'}${stage.error ? `\n\nError: ${stage.error}` : ''}`);
		if (stage.answer) {
			sections.push(stage.answer.summary);
			for (const finding of stage.answer.findings) { sections.push(`### ${finding.severity}: ${finding.title}\n\n${finding.file}:${finding.line}\n\n${finding.detail}\n\nEvidence:\n\n${finding.evidence}`); }
			sections.push(`Disagreements:\n${stage.answer.dissent.map(item => `- ${item}`).join('\n') || 'None reported.'}\n\nUnanswered questions:\n${stage.answer.questions.map(item => `- ${item}`).join('\n') || 'None reported.'}`);
		} else if (stage.text) { sections.push(`Partial / unstructured response:\n\n${stage.text}`); }
	}
	return sections.join('\n\n') + '\n';
}
export type CouncilSummary = Pick<CouncilReport, 'id' | 'sequence' | 'objective' | 'status' | 'createdAt'> & { hasBoard: boolean };
function summarize(report: CouncilReport): CouncilSummary { return { id: report.id, sequence: report.sequence, objective: report.objective, status: report.status, createdAt: report.createdAt, hasBoard: !!report.board }; }
/** Atomic JSON is authoritative; Markdown is regenerated from it for export. */
export class CouncilStore {
	constructor(readonly directory: string) {}
	path(id: string): string { if (!validId(id)) { throw new Error('Invalid Council report ID'); } return join(this.directory, `${id}.json`); }
	async save(report: CouncilReport): Promise<void> {
		const data = JSON.stringify(report);
		if (Buffer.byteLength(data) > MAX_REPORT_BYTES) { throw new Error('Council report exceeds size limit'); }
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const target = this.path(report.id);
		const temporary = `${target}.${randomUUID()}.tmp`;
		try { await writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); const info = await stat(temporary); await rename(temporary, target); await this.writeSummary(report, info).catch(() => {}); }
		finally { await unlink(temporary).catch(() => {}); }
	}
	async load(id: string): Promise<CouncilReport> {
		const file = this.path(id);
		if ((await stat(file)).size > MAX_REPORT_BYTES) { throw new Error('Council report exceeds size limit'); }
		const report = JSON.parse(await readFile(file, 'utf8')) as CouncilReport;
		if (report.version !== 1 || report.id !== id || !Array.isArray(report.stages) || !report.snapshot || !report.group) { throw new Error('Invalid Council report'); }
		return report;
	}
	private async writeSummary(report: CouncilReport, info: Stats): Promise<void> {
		const target = join(this.directory, `${report.id}.summary`), temporary = `${target}.${randomUUID()}.tmp`;
		try { await writeFile(temporary, JSON.stringify({ mtime: info.mtimeMs, size: info.size, inode: info.ino, summary: summarize(report) }), { mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
		finally { await unlink(temporary).catch(() => {}); }
	}
	/** Lightweight index records are disposable. Stale/missing records rebuild from authoritative JSON. */
	async summaries(limit = 200, offset = 0): Promise<CouncilSummary[]> {
		const files = (await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') { return []; } throw error; })).filter(file => file.endsWith('.json') && validId(file.slice(0, -5)));
		const summaries: CouncilSummary[] = [];
		for (let index = 0; index < files.length; index += 8) {
			const batch = await Promise.all(files.slice(index, index + 8).map(async file => {
				const id = file.slice(0, -5);
				try {
					const info = await stat(this.path(id)); const sidecar = join(this.directory, `${id}.summary`);
					try {
						if ((await stat(sidecar)).size > 64 * 1024) { throw new Error('Invalid summary size'); }
						const cached = JSON.parse(await readFile(sidecar, 'utf8')) as { mtime: number; size: number; inode: number; summary: CouncilSummary };
						if (cached.mtime === info.mtimeMs && cached.size === info.size && cached.inode === info.ino && cached.summary?.id === id && typeof cached.summary.createdAt === 'number' && typeof cached.summary.hasBoard === 'boolean') { return cached.summary; }
					} catch { /* Rebuild the index without changing the report. */ }
					const report = await this.load(id); const after = await stat(this.path(id));
					if (info.ino === after.ino && info.mtimeMs === after.mtimeMs && info.size === after.size) { await this.writeSummary(report, info).catch(() => {}); }
					return summarize(report);
				} catch { return undefined; /* One damaged report must not hide all history. */ }
			}));
			for (const summary of batch) { if (summary) { summaries.push(summary); } }
		}
		return summaries.sort((a, b) => b.createdAt - a.createdAt).slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(limit, 100_000)));
	}
	async list(): Promise<CouncilReport[]> {
		const reports: CouncilReport[] = [];
		for (const summary of await this.summaries()) { try { reports.push(await this.load(summary.id)); } catch { /* Report changed during listing. */ } }
		return reports;
	}
	/** Only recover reports whose owning process has exited. Never interrupt another live host. */
	async recover(): Promise<void> {
		for (const summary of await this.summaries(100_000)) {
			if (summary.status !== 'running') { continue; }
			const report = await this.load(summary.id);
			if (report.status !== 'running') { continue; }
			try { process.kill(report.ownerPid, 0); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') { continue; } }
			report.status = 'interrupted'; report.error = 'The owning process exited. Completed and partial results were retained.'; report.sequence++; report.updatedAt = Date.now();
			for (const stage of report.stages) { if (stage.status === 'running' || stage.status === 'pending') { stage.status = 'cancelled'; stage.error = 'Process exited'; } }
			await this.save(report);
		}
	}
	async exportMarkdown(id: string): Promise<string> {
		const report = await this.load(id); const file = join(this.directory, `${report.id}.md`);
		await writeFile(file, renderCouncilMarkdown(report), { mode: 0o600 }); return file;
	}
}
