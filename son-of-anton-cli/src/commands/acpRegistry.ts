/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { Command } from 'commander';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { AcpRegistry } from 'son-of-anton-core/dist/integrations/AcpRegistry';
import type { AcpAgentDefinition } from 'son-of-anton-core/dist/acp/protocol';
import { buildCliHost } from '../cliHost';

export function acpRegistryCommand(): Command {
	const command = new Command('acp-registry').description('Browse and explicitly configure version-pinned ACP adapters.');
	const registry = () => new AcpRegistry(join(homedir(), '.son-of-anton', 'acp-registry'));
	command.command('list').option('--refresh', 'Refresh the bounded registry cache').action(async (options: { refresh?: boolean }) => { const catalog = await registry().catalog(options.refresh); process.stdout.write(JSON.stringify(catalog, null, 2) + '\n'); });
	command.command('plan <id>').description('Show the concrete package or verified binary installation plan without executing it').action(async (id: string) => { process.stdout.write(JSON.stringify(await registry().plan(id), null, 2) + '\n'); });
	command.command('configure <id>').description('Save a pinned package launch; binary adapters require --install to download and verify first').option('--install', 'Download and verify a binary adapter before configuring it').action(async (id: string, options: { install?: boolean }) => {
		const source = registry(); const plan = await source.plan(id);
		if (!plan.launch && !options.install) { throw new Error('Binary adapter requires explicit --install. Inspect sota acp-registry plan first.'); }
		const launch = plan.launch ?? await source.installBinary(id); const host = buildCliHost(); const current = host.config.get<AcpAgentDefinition[]>('sota.acp.agents', []);
		await host.config.update?.('sota.acp.agents', [...current.filter(agent => agent.id !== id), launch]);
		process.stdout.write(`${id} configured at ${plan.agent.version}. ${plan.kind === 'binary' ? 'Binary checksum verified.' : 'The pinned package is downloaded and executed by its runner on first use.'} No adapter was launched.\n`);
	});
	return command;
}
