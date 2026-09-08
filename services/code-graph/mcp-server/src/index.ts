#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type CodegraphEngine,
  type EngineConfig,
  EngineSession,
} from './engine.js';
import { TOOLS } from './tools.js';
import { z } from 'zod';
import { EditorOverlay, dependencyImpact } from './editorOverlay.js';

interface CliArgs {
  db: string;
  backend: 'embedded' | 'docker';
  indexRoot?: string;
  embedder: EngineConfig['embedder'];
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    db: process.env.CODE_GRAPH_DB ?? './codegraph.db',
    backend: 'embedded',
    embedder: { kind: 'none' },
  };

  for (const arg of argv) {
    if (arg.startsWith('--db=')) out.db = arg.slice('--db='.length);
    else if (arg.startsWith('--backend=')) {
      const v = arg.slice('--backend='.length);
      if (v === 'embedded' || v === 'docker') out.backend = v;
    } else if (arg.startsWith('--index-root=')) {
      out.indexRoot = arg.slice('--index-root='.length);
    } else if (arg === '--local-embedder') {
      out.embedder = { kind: 'local' };
    } else if (arg.startsWith('--provider-embedder=')) {
      // Format: --provider-embedder=ENDPOINT|MODEL|DIMS (set CODEGRAPH_EMBEDDING_API_KEY separately)
      const parts = arg.slice('--provider-embedder='.length).split('|');
      if (parts.length === 3) {
        const endpoint = parts[0]!.trim();
        const model = parts[1]!.trim();
        const dims = Number(parts[2]);
        if (!endpoint || !model) {
          console.error(
            '[codegraph] --provider-embedder requires non-empty ENDPOINT and MODEL; ignoring flag',
          );
        } else if (!Number.isInteger(dims) || dims <= 0) {
          console.error(
            `[codegraph] --provider-embedder DIMS must be a positive integer (got ${parts[2]}); ignoring flag`,
          );
        } else {
          out.embedder = {
            kind: 'provider',
            endpoint,
            model,
            dims,
            apiKey: process.env.CODEGRAPH_EMBEDDING_API_KEY,
          };
        }
      } else {
        console.error(
          '[codegraph] --provider-embedder expects ENDPOINT|MODEL|DIMS (set CODEGRAPH_EMBEDDING_API_KEY separately); ignoring flag',
        );
      }
    }
  }
  return out;
}

/**
 * Thrown when a tool call's arguments don't match the contract. Caught one
 * frame up so the caller can return an MCP `isError` result instead of a
 * stringly-typed silent failure.
 */
class ToolInputError extends Error {}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ToolInputError(`argument '${key}' is required and must be a non-empty string`);
  }
  return v;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > (key === 'depth' ? 20 : 100)) {
    throw new ToolInputError(`argument '${key}' must be a positive integer within the supported limit`);
  }
  return v;
}

async function dispatch(
  engine: CodegraphEngine,
  name: string,
  args: Record<string, unknown>,
  overlay: EditorOverlay,
  semanticReady: boolean,
): Promise<unknown> {
  switch (name) {
    case 'semantic_search': {
      const query = requireString(args, 'query');
      const limit = optionalNumber(args, 'limit', 10);
      if (args.scope !== undefined && (!Array.isArray(args.scope) || !args.scope.every(value => typeof value === 'string'))) { throw new ToolInputError('scope must be an array of paths'); }
      const scope = args.scope as string[] | undefined;
      return overlay.search(query, semanticReady ? await engine.semanticSearch(query, Math.min(100, limit + 32), scope) : [], limit, scope);
    }
    case 'file_summary':
      return overlay.fileSummary(engine, requireString(args, 'path'));
    case 'symbol_lookup': {
      const query = requireString(args, 'query');
      const limit = optionalNumber(args, 'limit', 20);
      return overlay.symbolLookup(engine, query, limit);
    }
    case 'dependency_traversal': {
      const path = requireString(args, 'path');
      const depth = optionalNumber(args, 'depth', 3);
      return engine.dependencyTraversal(path, depth);
    }
    case 'impact_analysis': {
      const path = requireString(args, 'path');
      const depth = optionalNumber(args, 'depth', 3);
      return args.details === true ? { ...dependencyImpact(engine, path, depth), unsavedDocuments: overlay.status } : engine.impactAnalysis(path, depth);
    }
    case 'find_references':
      return engine.findReferences(requireString(args, 'name'));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.backend !== 'embedded') { throw new Error('Use the dedicated Docker MCP gateway for the Docker backend.'); }
	const overlay = new EditorOverlay(args.indexRoot ?? process.cwd());
	const server = new Server({ name: 'codegraph', version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });
	const session = new EngineSession({ dbPath: args.db, indexRoot: args.indexRoot, embedder: args.embedder }, status => {
		console.error(`[codegraph-status] ${JSON.stringify(status)}`);
		void server.notification({ method: 'notifications/tools/list_changed' }).catch(() => {});
	});
	server.setNotificationHandler(z.object({ method: z.literal('notifications/son-of-anton/editor-overlay'), params: z.object({ workspace: z.string(), revision: z.number().int().nonnegative(), documents: z.array(z.object({ path: z.string(), version: z.number().int().nonnegative(), language: z.string(), text: z.string().max(256 * 1024), outlineAvailable: z.boolean(), symbols: z.array(z.object({ name: z.string(), kind: z.string(), start: z.number().int(), end: z.number().int() })).max(1000) })).max(32) }) }), async notification => {
		const hadDocuments = overlay.size > 0;
		if (overlay.apply(notification.params) && hadDocuments !== (overlay.size > 0)) { await server.notification({ method: 'notifications/tools/list_changed' }); }
	});
	const statusTool = { name: 'codegraph_status', description: 'Read graph indexing, semantic search and watcher readiness.', inputSchema: { type: 'object' as const, properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } };
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [statusTool, ...(session.status.structural ? TOOLS.filter(tool => tool.name !== 'semantic_search' || (session.status.semantic === 'ready' || overlay.size > 0)).map(tool => ({ ...tool, annotations: { readOnlyHint: true, openWorldHint: false } })) : [])],
	}));
	server.setRequestHandler(CallToolRequestSchema, async req => {
		const { name, arguments: inputs = {} } = req.params;
		try {
			let result: unknown;
			if (name === 'codegraph_status') { result = { ...session.status, editorOverlay: overlay.status }; }
			else {
				if (!session.engine || !session.status.structural) { throw new Error(session.status.reason || 'Code graph is still indexing. Check codegraph_status.'); }
				if (name === 'semantic_search' && session.status.semantic !== 'ready' && overlay.size === 0) { throw new Error(`Semantic search is ${session.status.semantic}. Configure an embedder and check codegraph_status.`); }
				result = await dispatch(session.engine, name, inputs, overlay, session.status.semantic === 'ready');
			}
			return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
		} catch (error) {
			return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] };
		}
	});
	const shutdown = (): void => { session.dispose(); void server.close(); };
	process.once('SIGTERM', shutdown);
	process.once('SIGINT', shutdown);
	process.stdin.once('end', shutdown);
	await server.connect(new StdioServerTransport());
	// The MCP handshake is available while the initial scan/model download runs.
	void session.start();
}

main().catch(error => { console.error('[codegraph] fatal:', error); process.exitCode = 1; });
