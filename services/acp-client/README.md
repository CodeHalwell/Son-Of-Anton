# ACP client service

Shared ACP v1 runtime, bounded process reuse, authenticated HTTP/SSE task dispatch, cancellation and permission handling.

See the [ACP backend guide](../../docs/acp-backend.md) for setup, adapter commands, migration, limits, HTTP endpoints and validation. Build with Node 22. Update the vendored runtime from the repository root using `node scripts/sync-acp-runtime.mjs` after changing `son-of-anton-core/src/acp`.
