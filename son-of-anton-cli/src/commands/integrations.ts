/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Command, Option } from 'commander';
import { getSystemCatalog } from 'son-of-anton-core/dist/integrations/SystemCatalog';
import { buildCliHost } from '../cliHost';

/** Inspect external catalogs or select a server without copying its credentials. */
export function integrationsCommand(): Command {
	const command = new Command('integrations').description('Discover installed skills, plugins, and MCP servers from Claude, Codex, Cursor, and shared folders.');
	command.command('list').description('List integration metadata; does not launch servers.')
		.addOption(new Option('--output <mode>', 'Output mode').choices(['text', 'json']).default('text'))
		.action(async (options: { output: string }) => {
			const host = buildCliHost();
			const catalog = await getSystemCatalog({ workspace: host.workspace.folders[0]?.fsPath }, true);
			const raw = host.config.get<unknown>('sota.integrations.mcpServers');
			const selected = new Set(Array.isArray(raw) ? raw : []);
			const entries = catalog.entries.map(entry => ({ ...entry, configured: selected.has(entry.id) }));
			if (options.output === 'json') { process.stdout.write(JSON.stringify({ entries, issues: catalog.issues }, null, 2) + '\n'); }
			else {
				for (const entry of entries) { process.stdout.write(`${entry.id}  ${entry.kind}  ${entry.source}/${entry.scope}  ${entry.name}  [${entry.configured ? 'configured' : entry.enabled ? 'available' : entry.reason}]\n`); }
				for (const issue of catalog.issues) { process.stderr.write(`${issue.message} ${issue.path}\n`); }
			}
		});
	for (const action of ['connect', 'disconnect'] as const) {
		command.command(`${action} <id>`).description(action === 'connect' ? 'Select a discovered MCP server for subsequent trusted CLI sessions.' : 'Remove a discovered MCP server from CLI sessions.')
			.action(async (id: string) => {
				const host = buildCliHost();
				if (action === 'connect') {
					const catalog = await getSystemCatalog({ workspace: host.workspace.folders[0]?.fsPath }, true);
					if (!catalog.servers.has(id)) { throw new Error('Unknown or unavailable MCP server. Use sota integrations list to find an available server ID.'); }
				}
				const raw = host.config.get<unknown>('sota.integrations.mcpServers');
				const selected = new Set(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : []);
				if (action === 'connect') { selected.add(id); } else { selected.delete(id); }
				await host.config.update?.('sota.integrations.mcpServers', [...selected]);
				process.stdout.write(action === 'connect' ? 'Configured. The server will connect in subsequent CLI sessions when the workspace is trusted.\n' : 'Disconnected for subsequent CLI sessions.\n');
			});
	}
	return command;
}
