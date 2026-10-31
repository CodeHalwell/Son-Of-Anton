/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { describe, expect, it } from 'vitest';
import { privateRuntimeEnvironment, resolveRuntimeEndpoint, sameRuntimeEndpoint } from '../src/runtimeProfile.js';

const environment = { HOME: '/user', XDG_RUNTIME_DIR: '/run/u', CODYPENDENT_SOCKET: '/other/cody.sock',
	CODYPENDENT_DATA_DIR: '/other/data', CODYPENDENT_CONFIG_DIR: '/other/config', AGENT_RUNTIME_PRODUCT: 'codypendent' };

describe('independent product runtime selection', () => {
	it('defaults to Anton even when launched from Codypendent', () => {
		const endpoint = resolveRuntimeEndpoint({}, environment, 'linux');
		const child = privateRuntimeEnvironment(endpoint, environment, 'linux');
		expect({ mode: endpoint.mode, socket: endpoint.socketPath, product: child.AGENT_RUNTIME_PRODUCT,
			data: child.SON_OF_ANTON_DATA_DIR, config: child.SON_OF_ANTON_CONFIG_DIR,
			codySocket: child.CODYPENDENT_SOCKET, codyData: child.CODYPENDENT_DATA_DIR, codyConfig: child.CODYPENDENT_CONFIG_DIR }).toEqual({
			mode: 'local', socket: '/run/u/son-of-anton/daemon.sock', product: 'son-of-anton',
			data: '/user/.local/share/son-of-anton', config: '/user/.config/son-of-anton',
			codySocket: undefined, codyData: undefined, codyConfig: undefined,
		});
		expect(environment.AGENT_RUNTIME_PRODUCT).toBe('codypendent');
	});

	it('uses the product-specific overrides consistently for every child process', () => {
		const env = { ...environment, SON_OF_ANTON_DATA_DIR: '/anton', SON_OF_ANTON_CONFIG_DIR: '/anton-settings', SON_OF_ANTON_SOCKET: '/anton.sock' };
		const endpoint = resolveRuntimeEndpoint({}, env, 'linux');
		const child = privateRuntimeEnvironment(endpoint, env, 'linux');
		expect([endpoint.mode, endpoint.socketPath, child.SON_OF_ANTON_DATA_DIR, child.SON_OF_ANTON_CONFIG_DIR, child.SON_OF_ANTON_SOCKET])
			.toEqual(['local', '/anton.sock', '/anton', '/anton-settings', '/anton.sock']);
	});

	it('attaches to Codypendent only when explicitly selected', () => {
		const endpoint = resolveRuntimeEndpoint({ connection: 'external' }, environment, 'linux');
		expect([endpoint.mode, endpoint.socketPath]).toEqual(['external', '/other/cody.sock']);
		expect(() => privateRuntimeEnvironment(endpoint, environment, 'linux')).toThrow(/external runtime/);
	});

	it('preserves an explicitly configured custom socket as an external connection', () => {
		const endpoint = resolveRuntimeEndpoint({ socketPath: '/explicit/runtime.sock' }, environment, 'linux');
		expect([endpoint.mode, endpoint.socketPath]).toEqual(['external', '/explicit/runtime.sock']);
	});

	it('never takes the companion product selector as an implicit choice', () => {
		const endpoint = resolveRuntimeEndpoint({}, { ...environment, AGENT_RUNTIME_PRODUCT: 'unrecognized' }, 'linux');
		expect(endpoint.socketPath).toBe('/run/u/son-of-anton/daemon.sock');
	});

	it('assigns distinct identities and rejects captured endpoints after a switch', () => {
		const local = resolveRuntimeEndpoint({}, environment, 'linux');
		const external = resolveRuntimeEndpoint({ connection: 'external' }, environment, 'linux');
		const changed = resolveRuntimeEndpoint({ socketPath: '/new.sock' }, environment, 'linux');
		expect([sameRuntimeEndpoint(local, { ...local }), sameRuntimeEndpoint(local, external), sameRuntimeEndpoint(external, changed),
			sameRuntimeEndpoint({ ...local, socketPath: '/forged.sock' }, local)]).toEqual([true, false, false, false]);
	});

	it.each([{ connection: 'unknown' }, { socketPath: 'relative.sock' }, { socketPath: `/${'x'.repeat(101)}` }])('rejects invalid runtime configuration %j', settings => {
		expect(() => resolveRuntimeEndpoint(settings, environment, 'linux')).toThrow();
	});

	it('uses independent platform directories on macOS', () => {
		const endpoint = resolveRuntimeEndpoint({}, { HOME: '/user' }, 'darwin');
		const child = privateRuntimeEnvironment(endpoint, { HOME: '/user' }, 'darwin');
		expect([endpoint.socketPath, child.SON_OF_ANTON_DATA_DIR, child.SON_OF_ANTON_CONFIG_DIR]).toEqual([
			'/user/Library/Application Support/son-of-anton/run/daemon.sock', '/user/Library/Application Support/son-of-anton', '/user/Library/Application Support/son-of-anton',
		]);
	});
});
