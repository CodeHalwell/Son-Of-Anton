/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * The 6 MCP tool definitions exposed by the codegraph backend.
 *
 * Schema shapes match the orchestrator's expectations as described in
 * `plan.md`. Changes here are observable to anyone calling the MCP server.
 */
export const TOOLS: Tool[] = [
  {
    name: 'semantic_search',
    description:
      'Search saved symbols using configured embeddings and unsaved editor symbols using local text matching. Each unsaved hit is labelled with its document version and retrieval method.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language query, e.g. "where is the database connection opened".',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of hits to return.',
          default: 10,
        },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional path prefixes; results outside these prefixes are filtered out.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'file_summary',
    description:
      "Return the symbol outline (functions, classes, types) of a single file.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or repo-relative path.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'symbol_lookup',
    description: 'Find symbols by name. Exact matches rank first.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'dependency_traversal',
    description:
      'Walk outgoing call edges from a file up to N hops. Returns the set of files reachable.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        depth: { type: 'number', default: 3 },
      },
      required: ['path'],
    },
  },
  {
    name: 'impact_analysis',
    description:
      'Reverse traversal over persisted file dependencies. Set details to return evidence paths; unsaved dependency changes are not indexed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        details: { type: 'boolean', description: 'Return dependency paths and overlay freshness instead of a flat file list.' },
        depth: { type: 'number', default: 3 },
      },
      required: ['path'],
    },
  },
  {
    name: 'find_references',
    description: 'Find every edge that targets a symbol with the given name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    },
  },
];
