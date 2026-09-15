import { parameterizedQuery, decodeCompactResult, type CypherValue } from '../../_shared/cypher/dist/index.js';
// Copyright (c) Son of Anton Contributors. All rights reserved.
// Licensed under the MIT License.

import { createClient, RedisClientType } from 'redis';

export interface GraphRecord {
	[key: string]: CypherValue;
}

export interface GraphQueryResult {
	headers: string[];
	rows: GraphRecord[][];
}

export class FalkorDBClient {
	private client: RedisClientType | null = null;
	private readonly host: string;
	private readonly port: number;
	private readonly graphName: string;

	constructor(host?: string, port?: number, graphName?: string) {
		this.host = host ?? process.env.FALKORDB_HOST ?? 'localhost';
		this.port = port ?? parseInt(process.env.FALKORDB_PORT ?? '6379', 10);
		this.graphName = graphName ?? 'son-of-anton';
	}

	async connect(): Promise<void> {
		if (this.client) {
			return;
		}
		this.client = createClient({
			socket: {
				host: this.host, port: this.port, connectTimeout: 3000,
				reconnectStrategy: retries => Math.min(250 * 2 ** Math.min(retries, 5), 5000),
			},
			disableOfflineQueue: true,
			commandsQueueMaxLength: 1000,
			password: process.env.FALKORDB_PASSWORD || undefined,
		}) as RedisClientType;
		// Redis emits errors during outages even while it is reconnecting.
		// Handle them so a datastore restart cannot terminate the gateway.
		this.client.on('error', (error: Error) => {
			console.error('[falkordb] Connection error:', error.message);
		});
		await this.client.connect();
	}

	async disconnect(): Promise<void> {
		const client = this.client;
		this.client = null;
		if (client?.isOpen) {
			await client.disconnect();
		}
	}

	async query(cypher: string, params?: Record<string, unknown>, timeout?: number): Promise<GraphQueryResult> {
		if (!this.client?.isReady) {
			throw new Error('FalkorDB client is not connected. Retry when the service is healthy.');
		}

		const timeoutMs = timeout ?? 500;
		const args = ['GRAPH.QUERY', this.graphName, parameterizedQuery(cypher, params)];
		args.push('TIMEOUT', String(timeoutMs), '--compact');

		const result = await this.sendWithDeadline(args, Math.max(1000, timeoutMs + 1000)) as unknown[];

		return this.parseResult(result);
	}

	async isHealthy(): Promise<boolean> {
		try {
			if (!this.client?.isReady) {
				return false;
			}
			const result = await this.sendWithDeadline(['GRAPH.QUERY', this.graphName, 'RETURN 1', 'TIMEOUT', '1000'], 2000);
			return Array.isArray(result);
		} catch {
			return false;
		}
	}

	private async sendWithDeadline(args: string[], milliseconds: number): Promise<unknown> {
		const client = this.client;
		if (!client?.isReady) {
			throw new Error('FalkorDB client is not ready');
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				client.sendCommand(args),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(new Error('FalkorDB request timed out; its completion is unknown'));
						// A server-side query timeout cannot bound a stalled socket.
						// Discard pending commands and reconnect; never replay writes.
						void this.reconnectAfterTimeout(client);
					}, milliseconds);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async reconnectAfterTimeout(client: RedisClientType): Promise<void> {
		try {
			if (this.client !== client || !client.isOpen) { return; }
			await client.disconnect();
			if (this.client === client) { await client.connect(); }
		} catch (error) {
			console.error('[falkordb] Reconnection failed:', error instanceof Error ? error.message : String(error));
		}
	}

	private parseResult(raw: unknown[]): GraphQueryResult {
		const result = decodeCompactResult(raw);
		return {
			headers: result.headers,
			rows: result.rows.map(row => row.map((value, index) => ({ [result.headers[index]]: value }))),
		};
	}
}
