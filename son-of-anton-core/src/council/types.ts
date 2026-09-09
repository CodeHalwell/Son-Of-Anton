/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
export interface CouncilMember {
	id: string;
	label: string;
	expertise: string;
	stance: 'investigate' | 'verify' | 'challenge' | 'synthesize';
	model?: string;
	acpAgent?: string;
	/** Must match an advertised ACP mode. Council never guesses a read-only mode. */
	readOnlyMode?: string;
}
export interface CouncilGroup {
	id: string;
	name: string;
	members: CouncilMember[];
	chair: CouncilMember;
	reviewer?: CouncilMember;
	quorum: number;
	rounds: number;
	concurrency: number;
	turnTimeoutMs: number;
	runTimeoutMs: number;
}
export interface CouncilSnapshot {
	workspace: string;
	base: string;
	head: string;
	digest: string;
	capturedAt: number;
	patch: string;
	files: string[];
	limitations: string[];
}
export interface CouncilFinding {
	title: string;
	severity: 'high' | 'medium' | 'low';
	file: string;
	line: number;
	side?: 'old' | 'new';
	/** Host-verified citation only; this does not verify reasoning or execute tests. */
	evidenceVerified?: boolean;
	evidence: string;
	detail: string;
}
export interface CouncilAnswer {
	summary: string;
	findings: CouncilFinding[];
	dissent: string[];
	questions: string[];
}
export interface CouncilUsage { inputTokens: number; outputTokens: number }
export interface CouncilStage {
	id: string;
	member: CouncilMember;
	round: number;
	kind: 'member' | 'chair' | 'reviewer';
	status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
	text: string;
	answer?: CouncilAnswer;
	error?: string;
	usage?: CouncilUsage;
	startedAt?: number;
	finishedAt?: number;
}
export type CouncilStatus = 'running' | 'completed' | 'quorum-failed' | 'chair-failed' | 'review-failed' | 'cancelled' | 'timed-out' | 'interrupted' | 'failed';
export interface CouncilReport {
	version: 1;
	id: string;
	sequence: number;
	ownerPid: number;
	objective: string;
	group: CouncilGroup;
	snapshot: CouncilSnapshot;
	status: CouncilStatus;
	createdAt: number;
	updatedAt: number;
	stages: CouncilStage[];
	error?: string;
	/** Explicitly promoted findings, restored by the host into their own board. */
	board?: { conversationId: string; items: Array<{ stageId: string; findingIndex: number }>; tasks?: Record<string, { state: 'backlog' | 'ready' | 'in-progress' | 'review' | 'done' | 'failed'; assignee: string; summary?: string; proposalId?: string; startedAt?: number; finishedAt?: number }> };
}
export interface CouncilTurn {
	conversationId: string;
	member: CouncilMember;
	workspace: string;
	prompt: string;
	signal: AbortSignal;
	timeoutMs: number;
	onText(text: string): void;
}
export interface CouncilRunner {
	run(turn: CouncilTurn): Promise<CouncilUsage | undefined>;
	release(conversationId: string): Promise<void>;
}
