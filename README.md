# Son of Anton

Son of Anton is a Code OSS editor with a shared agent runtime, a task board, a CLI, and a local code graph. The editor and CLI use `son-of-anton-core`; the native Rust graph runs in a bundled MCP process. Cloud model and embedding requests go to the provider you configure. Docker services are optional.

Download installers from [GitHub Releases](https://github.com/CodeHalwell/Son-Of-Anton/releases), or build them with the [IDE distribution workflow](https://github.com/CodeHalwell/Son-Of-Anton/actions/workflows/ide-distribution.yml). See the [installation guide](docs/installation.md) for platform downloads, first launch, updates and recovery. IDE releases use the `ide-v` prefix.

## Build and run

Use Node 22 (the pinned version is in `.nvmrc`), npm, Git, and the Rust toolchain in `crates/rust-toolchain.toml`. Building the editor also requires the platform prerequisites described in the inherited [contributor guide](CONTRIBUTING.md).

```sh
npm ci
npm run bootstrap:sota
npm run watch
```

Wait for the editor watch build to finish, then run `./scripts/code.sh` in a second terminal. `bootstrap:sota` installs and builds the core, CLI, graph MCP server, platform native module, extension, and board. After dependencies are installed, `node scripts/bootstrap-sota.mjs --skip-install --debug` rebuilds with a debug native module.

Open a workspace, configure a provider in Son of Anton chat, and ask Anton to explain a small part of the project. The task board exposes task status, search, filters and execution actions. Writes and commands follow the configured approval policy. Retained Git checkpoints capture the working tree and index; restoring previews affected paths and creates a recovery checkpoint.

For CLI diagnostics:

```sh
node son-of-anton-cli/dist/cli.js doctor
node son-of-anton-cli/dist/cli.js auth status
node son-of-anton-cli/dist/cli.js chat --no-tui "Explain this project"
```

`doctor` makes no model requests. It reports local tools, credential presence, model tool support and installed graph assets, with repair actions. Account access and live graph readiness are separate checks.

## Code graph

The embedded graph requires no containers. It indexes supported source files, watches edits and removes deleted or moved symbols. A database belongs to one canonical workspace. Open the Code Graph status item to inspect initialization or errors.

The default embedder is `none`: structural search works; semantic search is unavailable until an embedder is configured. Provider embeddings send selected source code to that provider and may incur charges. See the [graph guide](services/code-graph/README.md) for capabilities and packaged assets.

## Credentials

IDE/CLI credential sharing uses the OS credential store: Keychain on macOS, Secret Service (`secret-tool`) on Linux, and DPAPI on Windows. Environment variables remain usable without persisting them. `sota auth save` explicitly persists supported environment credentials. `sota auth migrate` verifies a migration from the legacy plaintext file before removing that file. Plaintext compatibility storage requires the explicit `SOTA_ALLOW_PLAINTEXT_SECRETS=1` environment setting.

## ACP agents

Every built-in specialist can run through `sota acp`. Configure external ACP agents per specialist to use installed Gemini, Codex or Claude adapters, with bounded process reuse, cancellation and permission handling. See the [ACP backend guide](docs/acp-backend.md) for configuration and compatibility limits.

## Optional services

The full Compose stack is opt-in and requires configuration from `.env.example`, including `SOTA_SERVICE_TOKEN`:

```sh
docker compose --profile services up -d
docker compose --profile services ps
docker compose --profile services down
```

The `security` and `tracing` profiles enable additional services; combine them with `services` when their dependencies are needed. Normal shutdown preserves data. `down -v` is a deliberate destructive reset. The Compose `mock` embedder is a fixture option, not meaningful semantic retrieval. See [operations](docs/local-operations.md) for resource planning and retention.

## Verification

```sh
npm --prefix son-of-anton-core test
npm --prefix son-of-anton-cli test
npm --prefix extensions/son-of-anton test
npm run test:sota:offline
npm --prefix extensions/son-of-anton run test:ui
node scripts/check-case-collisions.mjs
```

Build before running tests. The UI suite needs Playwright Chromium (`npx playwright install chromium`) or `SOTA_UI_BROWSER` pointing to a Chromium executable. Offline suites use synthetic provider responses and temporary workspaces. They check behavior without making paid model requests. [Implementation notes](docs/improvement-implementation.md) record coverage and remaining validation limits.

## Repository

| Path | Purpose |
|---|---|
| `extensions/son-of-anton` | Editor chat, task board, approvals, graph integration |
| `son-of-anton-core` | Shared agent, provider, checkpoint and MCP runtime |
| `son-of-anton-cli` | Interactive and headless CLI |
| `crates` | Native code graph and N-API binding |
| `services/code-graph/mcp-server` | Bundled graph MCP process |
| `services`, `son-of-anton-mcp` | Optional services and MCP integrations |
| `src`, `build` | Code OSS editor and packaging |

Contributions follow the modification tiers and validation requirements in [CLAUDE.md](CLAUDE.md). [Fork maintenance](docs/fork-maintenance.md) documents ownership and update rehearsal. Licensed under [MIT](LICENSE.txt), with original Microsoft attribution retained.
