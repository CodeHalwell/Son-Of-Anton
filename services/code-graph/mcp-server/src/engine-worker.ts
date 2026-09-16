/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
import { createRequire } from 'node:module';
import type { CodegraphEngine } from './engine.js';

export type EngineMethod = Exclude<keyof CodegraphEngine, 'dispose'>;
export interface EngineRequest { id: number; method: EngineMethod; args: unknown[]; }
export interface EngineReply { id: number; value?: unknown; error?: string; }

if (!process.send) { throw new Error('The native engine must run in a worker process'); }
process.once('disconnect', () => { process.kill(process.pid, 'SIGTERM'); });
const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
const engine = require(process.env.CODEGRAPH_NAPI_PATH || '@son-of-anton/codegraph-napi') as CodegraphEngine;
process.on('message', async (request: EngineRequest) => {
	try {
		const operation = engine[request.method];
		if (typeof operation !== 'function') { throw new Error(`Native engine does not provide ${request.method}`); }
		const value: unknown = await Reflect.apply(operation, engine, request.args);
		process.send?.({ id: request.id, value } satisfies EngineReply);
	} catch (error) {
		process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies EngineReply);
	}
});
