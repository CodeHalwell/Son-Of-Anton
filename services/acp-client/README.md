# ACP client service

Shared ACP v1 runtime, bounded process reuse, authenticated HTTP/SSE task dispatch, cancellation and permission handling.

See the [ACP backend guide](../../docs/acp-backend.md) for setup, adapter commands, migration, limits, HTTP endpoints and validation. Build with Node 22. Update the vendored runtime from the repository root using `node scripts/sync-acp-runtime.mjs` after changing ACP or its dependencies in `son-of-anton-core/src`.

Staging compiles the ACP entry points and only their transitive dependencies into a clean directory, preserving the `dist/acp`, `dist/llm` and host declaration paths. `node scripts/sync-acp-runtime.mjs --check` verifies the complete file set and imports the packaged runtime. The standalone Docker build copies that same tree and runs `npm run check:runtime` after compilation; no full core or LLM SDK bundle is required.
