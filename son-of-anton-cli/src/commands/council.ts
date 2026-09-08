/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { Command } from 'commander';
import { realpath } from 'node:fs/promises';
import { CouncilStore, renderCouncilMarkdown } from 'son-of-anton-core/dist/council/CouncilStore';
import { CouncilService } from 'son-of-anton-core/dist/council/CouncilService';
import { CouncilModelRunner } from 'son-of-anton-core/dist/council/CouncilModelRunner';
import { captureCouncilSnapshot } from 'son-of-anton-core/dist/council/snapshot';
import { councilDirectory, createCouncilGroupsFile, readCouncilGroups } from 'son-of-anton-core/dist/council/config';
import { AcpRuntime } from 'son-of-anton-core/dist/acp/AcpRuntime';
import type { AcpAgentDefinition } from 'son-of-anton-core/dist/acp/protocol';
import { LlmClient } from 'son-of-anton-core/dist/llm/LlmClient';
import { buildCliHost } from '../cliHost';
import { bootstrapCredentials } from '../auth/bootstrap';

export function councilCommand(): Command {
	const command = new Command('council').description('Independent, durable reviews of a captured Git diff.');
	const resources = async () => { const host = buildCliHost(); const workspace = await realpath(host.workspace.folders[0]?.fsPath ?? process.cwd()); const store = new CouncilStore(host.config.get<string>('sota.council.storageDirectory') || councilDirectory(workspace)); await store.recover(); return { host, workspace, store }; };
	command.command('groups').option('--create', 'Create an editable groups.json with defaults').action(async (options: { create?: boolean }) => {
		const { host, store } = await resources(); const model = host.config.get<string>('defaultModel', 'sonnet');
		process.stdout.write(options.create ? await createCouncilGroupsFile(store.directory, model) + '\n' : JSON.stringify(await readCouncilGroups(store.directory, model), null, 2) + '\n');
	});
	command.command('history').action(async () => { const { store } = await resources(); const reports = await store.list(); process.stdout.write(JSON.stringify(reports.map(report => ({ id: report.id, status: report.status, objective: report.objective, updatedAt: report.updatedAt, digest: report.snapshot.digest })), null, 2) + '\n'); });
	command.command('show <id>').option('--json', 'Print the complete report including captured evidence').action(async (id: string, options: { json?: boolean }) => { const { store } = await resources(); const report = await store.load(id); process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : renderCouncilMarkdown(report)); });
	command.command('run <objective>').option('--base <revision>', 'Compare tracked working state against this Git revision', 'HEAD').option('--group <id>', 'Saved Council group', 'change-review').option('--rounds <count>', 'Override the saved round count').option('--final-review', 'Include the saved independent reviewer').action(async (objective: string, options: { base: string; group: string; rounds?: string; finalReview?: boolean }) => {
		const { host, workspace, store } = await resources();
		if (!host.workspace.isTrusted) { throw new Error('Council requires workspace trust. Set SOTA_TRUST_WORKSPACE=1 only for a workspace you trust.'); }
		await bootstrapCredentials(host);
		const group = (await readCouncilGroups(store.directory, host.config.get<string>('defaultModel', 'sonnet'))).find(group => group.id === options.group);
		if (!group) { throw new Error('Unknown Council group. Run sota council groups.'); }
		const snapshot = await captureCouncilSnapshot(workspace, options.base);
		const acp = new AcpRuntime(); const service = new CouncilService(store, new CouncilModelRunner(new LlmClient(host.secrets, host.config), acp, () => host.config.get<AcpAgentDefinition[]>('sota.acp.agents', []), () => host.workspace.isTrusted));
		let id: string | undefined;
		const cancel = () => { if (id && service.isOwned(id)) { service.cancel(id); } };
		process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
		const subscription = service.onChange(report => { process.stderr.write(`[council] ${report.id} ${report.status} ${report.stages.filter(stage => stage.status === 'completed').length} stages completed\n`); });
		try {
			id = await service.start(objective, { ...group, rounds: options.rounds === undefined ? group.rounds : Number(options.rounds), reviewer: options.finalReview ? group.reviewer : undefined }, snapshot);
			const report = await service.wait(id); process.stdout.write(renderCouncilMarkdown(report)); if (report.status !== 'completed') { process.exitCode = 1; }
		} finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); subscription.dispose(); await service.dispose(); await acp.shutdown(); }
	});
	return command;
}
