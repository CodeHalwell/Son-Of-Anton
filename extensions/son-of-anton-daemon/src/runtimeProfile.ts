/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveRuntimePaths, validateSocketPath, type Env } from '@codypendent/protocol/node';

export interface RuntimeEndpoint {
	socketPath: string;
	identity: string;
	mode: 'local' | 'external';
}

export interface RuntimeSettings {
	connection?: string;
	socketPath?: string;
}

/** Resolve a product-owned runtime unless the user explicitly selected another endpoint. */
export function resolveRuntimeEndpoint(settings: RuntimeSettings, env: Env = process.env, platform: NodeJS.Platform = process.platform): RuntimeEndpoint {
	const connection = settings.connection ?? 'local';
	if (connection !== 'local' && connection !== 'external') { throw new Error('Choose a local or external agent runtime.'); }
	const override = settings.socketPath?.trim() ? settings.socketPath : undefined;
	const mode = connection === 'external' || override ? 'external' : 'local';
	const product = mode === 'local' ? 'son-of-anton' : 'codypendent';
	const socketPath = override ?? resolveRuntimePaths(env, platform, product).socketPath;
	if (!path.isAbsolute(socketPath)) { throw new Error('The agent runtime socket path must be absolute.'); }
	validateSocketPath(socketPath, product);
	const normalized = path.normalize(socketPath);
	return { mode, socketPath: normalized, identity: createHash('sha256').update(`${mode}\0${normalized}`).digest('hex') };
}

function runtimePathOverrides(endpoint: RuntimeEndpoint, env: Env, platform: NodeJS.Platform) {
	if (endpoint.mode !== 'local') { throw new Error('An external runtime owns its environment and configuration.'); }
	const paths = resolveRuntimePaths(env, platform, 'son-of-anton');
	return {
		AGENT_RUNTIME_PRODUCT: 'son-of-anton', SON_OF_ANTON_DATA_DIR: paths.dataDir,
		SON_OF_ANTON_CONFIG_DIR: paths.configDir, SON_OF_ANTON_SOCKET: endpoint.socketPath
	};
}

/** Terminal creation options are visible to other extensions. Only expose namespace overrides. */
export function terminalRuntimeEnvironment(endpoint: RuntimeEndpoint) {
	return {
		...runtimePathOverrides(endpoint, process.env, process.platform),
		CODYPENDENT_DATA_DIR: null, CODYPENDENT_CONFIG_DIR: null, CODYPENDENT_SOCKET: null
	};
}

export function privateRuntimeEnvironment(endpoint: RuntimeEndpoint, env: Env = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
	const result = { ...env };
	delete result.CODYPENDENT_DATA_DIR;
	delete result.CODYPENDENT_CONFIG_DIR;
	delete result.CODYPENDENT_SOCKET;
	return { ...result, ...runtimePathOverrides(endpoint, env, platform) };
}

/** A captured endpoint must still be selected before a command can use it. */
export function sameRuntimeEndpoint(expected: RuntimeEndpoint, current: RuntimeEndpoint): boolean {
	return expected.identity === current.identity && expected.socketPath === current.socketPath && expected.mode === current.mode;
}
