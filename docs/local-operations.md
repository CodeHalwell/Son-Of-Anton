# Local operation and retention

The default editor needs the core, extension and embedded graph only. Source parsing and SQLite storage run locally. Semantic embedding is disabled by default. Configure a local or provider embedder deliberately; provider requests include source snippets. Model generation uses the selected provider and its billing rules.

The Compose services are opt-in through `--profile services`; security testing requires `--profile security`, and tracing requires `--profile tracing`. This keeps a normal editor session from starting databases, browsers, workers or a proxy router. All exposed Compose ports remain bound to loopback.

Planning allowances below are starting budgets, not measured benchmarks; inspect `docker stats` and adjust limits for the repository and workload.

| Capability | Initial planning allowance | Persistence / shutdown |
|---|---|---|
| Embedded structural graph | Hundreds of MB; larger repositories and parsing bursts can need more | Workspace-specific SQLite cache; stop before deleting and reindexing |
| FalkorDB + Qdrant + indexer/gateway | Reserve a few GB of RAM and disk for indexes | Named volumes; `down` preserves them |
| PostgreSQL and database MCP | Additional database RAM/disk according to imported data | Database storage; take backups before a reset |
| Browser / visual regression workers | Budget roughly 1–2 GB per active browser as an initial allowance | Task artifacts may contain screenshots/source; clear when no longer needed |
| Security testing (ZAP) | Reserve several GB for scans | Scan reports may contain application data; retain deliberately |
| Background tasks / checkpoints | Scales with concurrent jobs and snapshot size | Task volume and retained Git refs; use checkpoint pruning rather than deleting arbitrary refs |
| Model router / orchestration services | Start with hundreds of MB each; provider queues and context dominate growth | Local metrics are process-local; model provider retention is separate |
| Jaeger tracing | Reserve at least hundreds of MB and bound stored traces | Use the tracing profile only when required |

Do not run `docker compose down -v` as ordinary shutdown: it removes named volumes. Do not clear the user's stash or bisect state to repair a working tree. `sota doctor` reports actionable local setup information without printing credential values or sending model requests.

## Service configuration

Run `node scripts/configure-services.mjs` once to create a private `.env` with independent random HTTP, task-service, FalkorDB, Qdrant and PostgreSQL credentials. No provider credentials are generated or copied. The command refuses to replace an existing file. Compose rejects missing datastore credentials, and protected HTTP routes reject requests when server credentials are missing.

For an existing `.env`, replace any example tokens and fill `FALKORDB_PASSWORD`, `QDRANT_API_KEY`, `DB_PASSWORD`, and `POSTGRES_ADMIN_PASSWORD` before starting the stack. Never rotate credentials by deleting data volumes. PostgreSQL's initialization variables apply only to a new database; existing databases require an authenticated password change, followed by updating their clients. The named `postgres-data` volume preserves new installations across container recreation. Back up an existing container's database before migrating it to that volume.

## Router contracts

`POST /v1/messages` preserves the legacy provider SSE format and supports translated tool-call histories. Non-streamed responses return the unified text/usage object and optional `toolCalls`.

`POST /v1/agent-events` requires `stream: true` and emits the shared agent-event contract. It resolves configured API-key providers plus `anthropic-oauth`, `chatgpt-oauth` and `copilot` through the credential broker. Consumers choose this endpoint explicitly; the shared core's direct provider clients remain independent of this optional service.

Both endpoints enforce cancellation, a configurable `MODEL_ROUTER_TIMEOUT_MS` deadline (default 120 seconds), and slow-client backpressure. Fallback is allowed before visible content; after that, failure terminates the stream. Token usage is recorded for streamed and non-streamed requests. Pricing remains an estimate from the local model table, not a billing reconciliation.

`GET /health` is liveness. Authenticated `GET /ready` reports configured provider availability and returns 503 if none are configured; it explicitly does not claim a successful live provider request. Metrics endpoints retain request/task identifiers and usage. OAuth availability requires the editor's local credential broker.

New PostgreSQL installations use a separate administrator and a restricted `readonly` login for the database MCP server. The reader gets SELECT access to public-schema tables created by the initialization administrator, with a read-only transaction default and 15-second query deadline. Grant read access explicitly for other schemas or object owners. Existing databases require a role/privilege migration; changing Compose variables does not modify existing database roles.

For an alternate configuration file, use `SOTA_ENV_FILE=/absolute/path/services.env docker compose --env-file /absolute/path/services.env --profile services up -d`. The variable also selects the model router’s container environment file.
