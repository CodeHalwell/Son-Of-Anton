# Embedded code graph

The supported editor path is an MCP server with a dedicated native worker process. The server remains responsive during native loading, SQLite work and vector construction. The worker stores parsed files, symbols, relationships and optional vectors in a workspace-bound SQLite database. Startup indexes the workspace before advertising structural tools. A serialized watcher reconciles edits, renames and deletes; it invalidates embeddings when content or embedding configuration changes. Shutdown stops the worker, including stalled model downloads; worker failure rejects pending calls and leaves status available. Excess work is rejected once 256 native requests are pending.

`npm run bootstrap:sota` builds the server and native module for the current platform. The editor loads `extensions/son-of-anton/runtime/codegraph/index.cjs`; it does not require a checkout-relative server in an installed application. The runtime contains `engine-worker.cjs`, a platform/architecture manifest, and its N-API loader and binary. Native assets must be built on the target platform; do not copy a macOS runtime into a Linux or Windows package.

## Capabilities

`codegraph_status` is always available, including failed startup. It reports structural availability, semantic state, last index time and index statistics. Structural tools are exposed only after indexing succeeds:

- `file_summary`, `symbol_lookup`, `find_references`
- `dependency_traversal`, `impact_analysis`
- `semantic_search`, only when a usable vector index is ready

With `sota.codeGraph.embedder` set to `none` (the default), structural tools work and semantic search is explicitly disabled. A provider embedder requires an endpoint, model and matching dimensions. It sends source snippets to that provider. Configure the final embedding URL: redirects are rejected so code is not forwarded to a different endpoint. Provider requests are limited to eight concurrent calls and a 30-second deadline including queue wait. Response bodies are bounded by the requested vector count and dimensions, with a 64 MiB ceiling; malformed or oversized responses leave structural tools available. HTTP diagnostics omit URLs and response bodies. The `local` option downloads about 130 MB for BGE-small-en-v1.5 on first use and stores the model beside the graph database. A cached model works offline. Download or embedding failures report degraded semantic capability while structural tools remain usable. Symbol lookup matches literal substrings, including underscores, and ranks exact names first.

Native parsing currently has its own supported-language set in `crates/sota-codegraph-core/src/parse`; unsupported files are not indexed. Git-ignored files and symlinks outside the workspace are excluded. Tree-sitter structure is not a substitute for a compiler's complete type resolution.

## Validate an installed runtime

```sh
npm run test:sota:offline
```

The suite copies the runtime away from the checkout, starts the actual MCP child, indexes source fixtures, queries the graph and verifies watcher freshness, workspace isolation, structural-only mode and missing-native diagnostics. Embeddings come from a local deterministic HTTP fixture. Set `SOTA_RUNTIME_SOURCE` to test an extracted application's runtime and `SOTA_EVAL_OUTPUT` to save the retrieval smoke results.

After compiling the server and building its native runtime, run the full graph suite, including real-model retrieval and a 2,002-symbol capacity fixture:

```sh
SOTA_TEST_LOCAL_EMBEDDINGS=1 SOTA_TEST_GRAPH_LOAD=1 node --test services/code-graph/mcp-server/test/*.test.mjs
```

The real-model fixture downloads and removes its own model cache. The capacity fixture uses generated 384-dimensional vectors to measure native throughput independently of model quality. The suite also tests slow native loading, worker exit, queue saturation, and cancellation of a stalled native download. `SOTA_LOCAL_EVAL_OUTPUT` and `SOTA_GRAPH_LOAD_OUTPUT` save measurements as JSON. Native distribution CI runs the offline and capacity checks by default; its manual `test_local_embeddings` input enables model downloads.

Use `sota doctor --runtime /path/to/runtime/codegraph` to inspect installation compatibility. Runtime presence does not establish live indexing readiness; query `codegraph_status` for that.

## Optional Docker stack

The root Compose deployment is separate from the embedded lifecycle. Connect its gateway explicitly in `sota.mcp.servers`. Selecting `docker` in the legacy backend setting now explains that setup instead of starting a second controller or probing obsolete ports. The old `services/code-graph/docker-compose.yml` is retained for compatibility; it is not the default editor backend. Root Compose services require `--profile services`.

Database files are derived local caches in the editor's workspace-specific storage. Stop the graph before deleting its cache to force a complete reindex. Normal editor shutdown and `docker compose down` preserve data.

Provider failure/recovery checks run with `node --test services/code-graph/mcp-server/test/provider-recovery.test.mjs` after compilation and native runtime construction. They use a loopback OpenAI-compatible test endpoint, including oversized content-length/chunked bodies, redirects, concurrency, credential rejection, recovery, and transport-error redaction. These establish protocol behavior rather than validate a live commercial provider.

For a longer native run, set `SOTA_TEST_GRAPH_SOAK=1` and run `node --test services/code-graph/mcp-server/test/soak.test.mjs`. It copies 50 application source files into an isolated installation, exercises concurrent queries and repeated edits for five minutes, rejects stale symbols, and bounds native-worker RSS growth after warmup on macOS/Linux. Windows still runs lifecycle checks, but RSS sampling is unavailable in this fixture. Set `SOTA_GRAPH_SOAK_OUTPUT` to retain measurements. Generated vectors measure capacity rather than semantic quality. The distribution workflow exposes the same opt-in `test_graph_soak` input.
