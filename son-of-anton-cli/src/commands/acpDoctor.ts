/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { diagnoseAcp } from 'son-of-anton-core/dist/acp/AcpDiagnostics';
import { validateAgent, type AcpAgentDefinition } from 'son-of-anton-core/dist/acp/protocol';
import { buildCliHost } from '../cliHost';
export function acpDoctorCommand(): Command {
	return new Command('acp-doctor').description('Probe configured ACP launches, authentication methods, and sessions; never approve tools.')
		.option('--file <path>', 'Read an ACP agents array or {agents: [...]} file')
		.option('--agent <id>', 'Probe only this adapter')
		.option('--live', 'Send a bounded no-tools model prompt (may use provider quota)')
		.option('--mode <id>', 'Require an advertised session mode')
		.action(async (options: { file?: string; agent?: string; live?: boolean; mode?: string }) => {
			const host = buildCliHost();
			const raw = options.file ? JSON.parse(await readFile(options.file, 'utf8')) as AcpAgentDefinition[] | { agents: AcpAgentDefinition[] } : host.config.get<AcpAgentDefinition[]>('sota.acp.agents', []);
			const agents = Array.isArray(raw) ? raw : raw.agents;
			if (!Array.isArray(agents)) { throw new Error('Expected an ACP agents array'); }
			const selected = agents.filter(agent => !options.agent || agent.id === options.agent);
			if (!selected.length) { throw new Error('No matching ACP adapters configured'); }
			for (const agent of selected) { validateAgent(agent); }
			const reports = [];
			for (const agent of selected) { reports.push(await diagnoseAcp(agent, process.cwd(), options)); }
			process.stdout.write(JSON.stringify(reports, null, 2) + '\n');
			if (reports.some(report => report.status !== 'session-ready' && report.status !== 'prompt-completed')) { process.exitCode = 1; }
		});
}
