# Embedded code graph

The supported editor path is a Rust engine in one MCP-owned Node process. It stores parsed files, symbols, relationships and optional vectors in a workspace-bound SQLite database. Startup indexes the workspace before advertising tools. A serialized watcher reconciles edits, renames and deletes; it invalidates embeddings when content or embedding configuration changes.

`npm run bootstrap:sota` builds the server and native module for the current platform. The editor loads `extensions/son-of-anton/runtime/codegraph/index.cjs`; it does not require a checkout-relative server in an installed application. The runtime contains a platform/architecture manifest and its N-API loader and binary. Native assets must be built on the target platform; do not copy a macOS runtime into a Linux or Windows package.

## Capabilities

`codegraph_status` is always available, including failed startup. It reports structural availability, semantic state, last index time and index statistics. Structural tools are exposed only after indexing succeeds:

- `file_summary`, `symbol_lookup`, `find_references`
- `dependency_traversal`, `impact_analysis`
- `semantic_search`, only when a usable vector index is ready

With `sota.codeGraph.embedder` set to `none` (the default), structural tools work and semantic search is explicitly disabled. A provider embedder requires an endpoint, model and matching dimensions. It sends source snippets to that provider. The `local` option works only in builds containing a local embedding implementation; otherwise the graph reports degraded semantic capability while structural tools remain usable.

Native parsing currently has its own supported-language set in `crates/sota-codegraph-core/src/parse`; unsupported files are not indexed. Git-ignored files and symlinks outside the workspace are excluded. Tree-sitter structure is not a substitute for a compiler's complete type resolution.

## Validate an installed runtime

```sh
npm run test:sota:offline
```

The suite copies the runtime away from the checkout, starts the actual MCP child, indexes source fixtures, queries the graph and verifies watcher freshness, workspace isolation, structural-only mode and missing-native diagnostics. Embeddings come from a local deterministic HTTP fixture. Set `SOTA_RUNTIME_SOURCE` to test an extracted application's runtime and `SOTA_EVAL_OUTPUT` to save the retrieval smoke results.

Use `sota doctor --runtime /path/to/runtime/codegraph` to inspect installation compatibility. Runtime presence does not establish live indexing readiness; query `codegraph_status` for that.

## Optional Docker stack

The root Compose deployment is separate from the embedded lifecycle. Connect its gateway explicitly in `sota.mcp.servers`. Selecting `docker` in the legacy backend setting now explains that setup instead of starting a second controller or probing obsolete ports. The old `services/code-graph/docker-compose.yml` is retained for compatibility; it is not the default editor backend. Root Compose services require `--profile services`.

Database files are derived local caches in the editor's workspace-specific storage. Stop the graph before deleting its cache to force a complete reindex. Normal editor shutdown and `docker compose down` preserve data.
