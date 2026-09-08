/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { randomUUID } from 'node:crypto';
import { CouncilStore } from './CouncilStore';
import { councilPrompt, parseCouncilAnswer, validateGroup } from './prompts';
import type { CouncilGroup, CouncilMember, CouncilReport, CouncilRunner, CouncilSnapshot, CouncilStage } from './types';

interface ActiveRun { controller: AbortController; done: Promise<CouncilReport> }
/** One durable event source serves every UI; reconnecting clients always request a snapshot. */
export class CouncilService {
	private readonly listeners = new Set<(report: CouncilReport) => void>();
	private readonly active = new Map<string, ActiveRun>();
	private readonly failures = new Map<string, Error>();
	private disposed = false;
	constructor(readonly store: CouncilStore, private readonly runner: CouncilRunner) {}
	onChange(listener: (report: CouncilReport) => void): { dispose(): void } { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
	isOwned(id: string): boolean { return this.active.has(id); }
	async start(objective: string, group: CouncilGroup, snapshot: CouncilSnapshot): Promise<string> {
		if (this.disposed || this.active.size) { throw new Error('A Council run is already active, or the service is closing.'); }
		validateGroup(group);
		if (!objective.trim() || objective.length > 8000) { throw new Error('Council objective must contain 1–8,000 characters.'); }
		const report: CouncilReport = { version: 1, id: randomUUID(), sequence: 0, ownerPid: process.pid, objective: objective.trim(), group: structuredClone(group), snapshot: structuredClone(snapshot), status: 'running', createdAt: Date.now(), updatedAt: Date.now(), stages: [] };
		const controller = new AbortController();
		// Reserve the slot before the first async write so two starts cannot race.
		const active: ActiveRun = { controller, done: Promise.resolve(report) }; this.active.set(report.id, active);
		try { await this.store.save(report); } catch (error) { this.active.delete(report.id); throw error; }
		active.done = this.execute(report, controller).catch(error => {
			this.failures.set(report.id, error instanceof Error ? error : new Error(String(error)));
			if (this.failures.size > 200) { this.failures.delete(this.failures.keys().next().value!); }
			throw error;
		}).finally(() => this.active.delete(report.id));
		void active.done.catch(() => {});
		return report.id;
	}
	async wait(id: string): Promise<CouncilReport> { const failure = this.failures.get(id); if (failure) { throw failure; } return this.active.get(id)?.done ?? this.store.load(id); }
	cancel(id: string): void { const run = this.active.get(id); if (!run) { throw new Error('This run is not owned by the current process.'); } run.controller.abort(new Error('Cancelled by user')); }
	async dispose(): Promise<void> { this.disposed = true; for (const run of this.active.values()) { run.controller.abort(new Error('Council service closed')); } await Promise.allSettled([...this.active.values()].map(run => run.done)); this.listeners.clear(); }

	private async execute(report: CouncilReport, controller: AbortController): Promise<CouncilReport> {
		let saveQueue = Promise.resolve();
		let saveError: Error | undefined;
		let timedOut = false;
		const publish = (): Promise<void> => {
			report.sequence++; report.updatedAt = Date.now(); const snapshot = structuredClone(report);
			saveQueue = saveQueue.then(async () => { await this.store.save(snapshot); for (const listener of this.listeners) { try { listener(structuredClone(snapshot)); } catch { /* observers cannot stop a run */ } } });
			void saveQueue.catch(error => { saveError = error; controller.abort(error); });
			return saveQueue;
		};
		const deadline = setTimeout(() => { timedOut = true; controller.abort(new Error('Council run deadline exceeded')); }, report.group.runTimeoutMs);
		let dirty = false;
		const checkpoint = setInterval(() => { if (dirty && !saveError) { dirty = false; void publish().catch(() => {}); } }, 1000);
		const stage = async (member: CouncilMember, round: number, kind: CouncilStage['kind'], previous: CouncilStage[]): Promise<CouncilStage> => {
			const result: CouncilStage = { id: `${round}-${kind}-${member.id}`, member, round, kind, status: 'pending', text: '' };
			report.stages.push(result);
			if (controller.signal.aborted) { result.status = 'cancelled'; await publish(); return result; }
			result.status = 'running'; result.startedAt = Date.now(); await publish();
			const turnController = new AbortController();
			const abort = () => turnController.abort(controller.signal.reason);
			controller.signal.addEventListener('abort', abort, { once: true });
			const timeout = setTimeout(() => turnController.abort(new Error('Participant deadline exceeded')), report.group.turnTimeoutMs);
			const conversationId = `council:${report.id}:${result.id}`;
			let removeAbort = () => {};
			try {
				if (controller.signal.aborted) { abort(); }
				const cancelled = new Promise<never>((_, reject) => {
					const listener = () => reject(turnController.signal.reason); removeAbort = () => turnController.signal.removeEventListener('abort', listener);
					turnController.signal.addEventListener('abort', listener, { once: true }); if (turnController.signal.aborted) { listener(); }
				});
				result.usage = await Promise.race([this.runner.run({ conversationId, member, workspace: report.snapshot.workspace, prompt: councilPrompt(report, result, previous), signal: turnController.signal, timeoutMs: report.group.turnTimeoutMs, onText: text => {
					if (result.status !== 'running' || turnController.signal.aborted) { return; }
					const remaining = 64 * 1024 - Buffer.byteLength(result.text);
					if (Buffer.byteLength(text) > remaining) { result.text += Buffer.from(text).subarray(0, Math.max(0, remaining)).toString('utf8'); turnController.abort(new Error('Participant response exceeded 64 KiB')); }
					else { result.text += text; }
					dirty = true;
				} }), cancelled]);
				turnController.signal.throwIfAborted();
				result.answer = parseCouncilAnswer(result.text, report.snapshot.files, report.snapshot.patch); result.status = 'completed';
			} catch (error) { result.status = controller.signal.aborted ? 'cancelled' : 'failed'; result.error = error instanceof Error ? error.message : String(error); }
			finally {
				clearTimeout(timeout); removeAbort(); controller.signal.removeEventListener('abort', abort);
				try { await this.runner.release(conversationId); } catch (error) { result.status = 'failed'; result.error = `Session cleanup failed: ${String(error)}`; }
				result.finishedAt = Date.now(); await publish();
			}
			return result;
		};
		try {
			for (let round = 1; round <= report.group.rounds && !controller.signal.aborted; round++) {
				const previous = structuredClone(report.stages); let next = 0;
				const results = await Promise.allSettled(Array.from({ length: Math.min(report.group.concurrency, report.group.members.length) }, async () => {
					while (next < report.group.members.length) { const member = report.group.members[next++]; await stage(member, round, 'member', previous); }
				}));
				const failure = results.find(result => result.status === 'rejected');
				if (failure?.status === 'rejected') { throw failure.reason; }
				if (report.stages.filter(item => item.kind === 'member' && item.round === round && item.status === 'completed').length < report.group.quorum) { report.status = 'quorum-failed'; report.error = `Round ${round} did not reach quorum (${report.group.quorum} completed members required).`; break; }
			}
			if (report.status === 'running' && !controller.signal.aborted) {
				const chair = await stage(report.group.chair, report.group.rounds, 'chair', structuredClone(report.stages));
				if (chair.status !== 'completed') { report.status = 'chair-failed'; report.error = 'Synthesis failed. Member reports remain available.'; }
				else if (report.group.reviewer && !controller.signal.aborted) {
					const review = await stage(report.group.reviewer, report.group.rounds, 'reviewer', structuredClone(report.stages));
					if (review.status !== 'completed') { report.status = 'review-failed'; report.error = 'Independent final review failed. Synthesis remains available but is not independently verified.'; }
				}
			}
			if (controller.signal.aborted) { report.status = timedOut ? 'timed-out' : 'cancelled'; report.error = String(controller.signal.reason?.message ?? 'Cancelled'); }
			else if (report.status === 'running') { report.status = 'completed'; }
		} catch (error) { controller.abort(error); report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); }
		finally { clearTimeout(deadline); clearInterval(checkpoint); }
		if (saveError) { throw new Error('Council could not persist its latest report.', { cause: saveError }); }
		await publish(); return structuredClone(report);
	}
}
