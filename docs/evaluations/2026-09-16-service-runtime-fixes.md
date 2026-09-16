# Service runtime packaging and indexing fixes — 16 September 2026

The merged build at `a9a8388dca540051ad734b464c0a2d9ef6a429b1` failed Docker Compose startup. Its logs show missing `./workspaceFs` from the auth entrypoint in database, deployment, tickets and Playwright MCP servers. The same run records Qdrant returning 400 for the indexer’s first point upsert.

## Auth packaging

The canonical build and copy loop already generated/copied `workspaceFs.js`. The MCP vendor directories were excluded by the generic `dist` ignore rule, so these files existed locally but were absent from Git and CI. The fix tracks `workspaceFs.js`, its declaration and source map in all four MCP contexts. It also synchronizes the legacy `son-of-anton-mcp/gateway` consumer, which the earlier loop omitted.

The sync check now requires every generated vendor artifact to be tracked by Git. An 18-consumer regression exports only staged Git files into isolated CommonJS directories, compares all sibling artifacts to the canonical package, loads the entrypoint, and exercises a workspace write/read. This specifically prevents ignored local output from hiding an incomplete checkout.

Validation: shared TypeScript compilation and consistency checks passed; all 18 Git-artifact regressions passed. Docker images for the four failing services were built from a clean export of the Git index using their unchanged Dockerfiles. All four passed Compose health checks with a disposable PostgreSQL instance for the database service. No live GitHub requests or deployments were made.

## Indexer point IDs

The embedding writer sent full 64-character SHA-256 strings as point IDs. A disposable real Qdrant instance reproduced HTTP 400 and explicitly required an unsigned integer or UUID. The writer now formats a deterministic 128-bit hash-derived version-8 UUID, preserving stable upserts for the same file/symbol identity. First indexing in a new process already clears existing points for that file, so the ID change requires no separate destructive migration.

Validation: indexer compilation and all 17 tests passed, including restart stability and distinct file/symbol IDs. The real Qdrant fixture accepted an initial write, an update retaining the same ID, a moved-symbol replacement with stale-point deletion, search, and final deletion. The full-stack CI assertion now requires `cartTotal` to exist in Qdrant as well as the graph, because graph writes can succeed before embedding writes fail.

The four-service Compose check and database fixture passed locally. Full 19-service CI on the follow-up commit remains pending.
