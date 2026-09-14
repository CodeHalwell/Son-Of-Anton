/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import { ACPClientImpl } from './client';
import { AgentRegistry } from './registry/agentRegistry';
import { createServer } from './server';
import { requireServiceToken } from '../_shared/auth/dist/index';
import { AcpRuntime } from '../_shared/acp/dist/AcpRuntime';

async function start(): Promise<void> {
	const token = requireServiceToken('acp-client');
	const port = Number(process.env.ACP_PORT ?? 3300);
	if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('ACP_PORT must be an integer from 1 to 65535'); }
	const workspace = path.resolve(process.env.PROJECT_PATH ?? process.cwd());
	const registry = new AgentRegistry(process.env.ACP_CONFIG_PATH ?? path.join(workspace, '.son-of-anton/agents/acp-agents.json'));
	await registry.load();
	const runtime = new AcpRuntime({ maxProcesses: Number(process.env.ACP_MAX_PROCESSES ?? 4), maxQueue: Number(process.env.ACP_MAX_QUEUE ?? 32) });
	const client = new ACPClientImpl(registry, workspace, runtime);
	const server = createServer(client, { token });
	let closing = false;
	const shutdown = async () => {
		if (closing) { return; } closing = true;
		registry.stopWatching();
		server.close();
		await client.shutdown();
		server.closeAllConnections();
	};
	process.once('SIGINT', () => { void shutdown(); });
	process.once('SIGTERM', () => { void shutdown(); });
	registry.on('reloadError', error => console.error('[acp] Invalid registry reload; keeping previous configuration:', error.message));
	void registry.startWatching();
	try {
		await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, process.env.ACP_HOST ?? '127.0.0.1', resolve); });
		console.log(`[acp] Listening on port ${port}; ${(await client.listAgents()).length} configured agents`);
	} catch (error) { await shutdown(); throw error; }
}
if (require.main === module) { void start().catch(error => { console.error('[acp] Startup failed:', error.message); process.exitCode = 1; }); }
export { ACPClientImpl, AgentRegistry, createServer };
export { ACPDispatcher } from './dispatcher';
