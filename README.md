# Son of Anton

Son of Anton is a Code OSS editor with its own bundled agent engine, a task board, a CLI, and a local code graph. It runs independently of Codypendent. The editor retains `son-of-anton-core` for native compatibility; normal Unix agent sessions use a private copy of the Rust engine. Cloud model and embedding requests go to the provider you configure. Docker services are optional.

Download installers from [GitHub Releases](https://github.com/CodeHalwell/Son-Of-Anton/releases), or build them with the [IDE distribution workflow](https://github.com/CodeHalwell/Son-Of-Anton/actions/workflows/ide-distribution.yml). See the [installation guide](docs/installation.md) for platform downloads, first launch, updates and recovery. IDE releases use the `ide-v` prefix.

## Build and run

Use Node 22 (the pinned version is in `.nvmrc`), npm, Git, and the Rust toolchain in `crates/rust-toolchain.toml`. Building the editor also requires the platform prerequisites described in the inherited [contributor guide](CONTRIBUTING.md).

```sh
npm ci
npm run bootstrap:sota
npm run watch
```

Let root `npm ci` finish with install scripts enabled: its postinstall provisions
the inherited built-in extensions as well as the editor's dependencies.
`bootstrap:sota` builds the Son of Anton stack and does not replace that step.
A partial install, such as root `npm ci --ignore-scripts`, can leave extension-local
dependencies missing and produce compiler errors for Node modules or global types
such as `Array`. Complete dependency setup before changing compiler settings.

Wait for the editor watch build to finish, then run `./scripts/code.sh` in a second terminal. `bootstrap:sota` installs and builds the core, CLI, private Rust engine, graph MCP server, platform native module, extensions, and board. After dependencies are installed, `node scripts/bootstrap-sota.mjs --skip-install --debug` rebuilds the private engine and native graph with debug binaries.

Open a workspace, configure a provider in Son of Anton chat, and ask Anton to explain a small part of the project. The Rust runtime's task board tracks and assigns repository work; moving a card does not launch a worker. Native compatibility mode also retains its planning and execution board. Writes and commands follow the owning runtime's approval policy. Native compatibility checkpoints capture the working tree and index; restoring previews affected paths and creates a recovery checkpoint. Rust sessions retain their own daemon-owned checkpoint records.

For native compatibility CLI diagnostics, separate from the private Rust runtime:

```sh
node son-of-anton-cli/dist/cli.js doctor
node son-of-anton-cli/dist/cli.js auth status
node son-of-anton-cli/dist/cli.js chat --no-tui "Explain this project"
```

`doctor` makes no model requests. It reports local tools, credential presence, model tool support and installed graph assets, with repair actions. Account access and live graph readiness are separate checks.

## Independent agent runtime and optional Codypendent connection

On Linux and macOS, primary chat, agent participants and inline assistance use Anton's privately bundled Rust engine. Configure models through **Son of Anton: Open Setup Wizard**. Anton owns its storage, configuration, credentials and socket; closing the editor leaves runs alive. The task board and graph inspector use the same product-owned engine.

**Son of Anton: Connect to Codypendent** explicitly attaches to a separately running companion runtime; **Use Local Agent Runtime** returns to Anton. **Open Shared Conversation** browses sessions in the selected runtime. External runtimes retain their own configuration and lifecycle. Existing native histories remain available through the native compatibility runtime, which is also the Windows default. See the [independent products plan](docs/independent-products.md), [runtime and migration guide](docs/shared-runtime.md) and [client guide](extensions/son-of-anton-daemon/README.md).

## Repository workflows

Choose **Son of Anton: Browse Repository Workflows** to inspect the selected
runtime's real catalog for a local repository. Definitions show their source,
version, digest, declared input types, and diagnostics. Enter each input as JSON;
workflow-specific types remain the runtime's responsibility. **Start Workflow**
is an explicit action in a trusted workspace and binds to the reviewed definition.

The panel monitors its saved launch receipts, with pause, resume, cancellation,
and node retry through the owning runtime. Closing it leaves durable work alive.
An uncertain start retains its request securely for explicit **Reconcile Start**;
reopening never starts or retries work automatically. Older external runtimes
without workflow catalog support show an unavailable state.

## Code graph

Rust mode uses the selected runtime's structural graph. Its inspector preserves evidence confidence, recorded revisions, freshness and result limits, with symbol drill-down and source navigation. In native compatibility mode, the embedded graph requires no containers. It indexes supported source files, watches edits and removes deleted or moved symbols. A database belongs to one canonical workspace. The native Code Graph status item reports that backend's initialization or errors.

The native compatibility graph's default embedder is `none`: structural search works; semantic search is unavailable until an embedder is configured. Provider embeddings send selected source code to that provider and may incur charges. The Rust graph inspector does not claim semantic retrieval or unsaved-buffer parity. See the [graph guide](services/code-graph/README.md) for the compatibility backend's capabilities and packaged assets.

## Credentials

The private Rust engine uses the runtime extension's SecretStorage for credentials saved in Anton's wizard or chat forms. Keys reach private child processes as environment values; model files store environment variable names. External connections keep their own credentials. Configuring the native compatibility CLI does not automatically configure the private engine.

Native compatibility IDE/CLI credential sharing uses the OS credential store: Keychain on macOS, Secret Service (`secret-tool`) on Linux, and DPAPI on Windows. Environment variables remain usable without persisting them. `sota auth save` explicitly persists supported environment credentials. `sota auth migrate` verifies a migration from the legacy plaintext file before removing that file. Plaintext compatibility storage requires the explicit `SOTA_ALLOW_PLAINTEXT_SECRETS=1` environment setting.

## ACP agents

Every native compatibility specialist can run through `sota acp`. Configure external ACP agents per specialist to use installed Gemini, Codex or Claude adapters, with bounded process reuse, cancellation and permission handling. These per-specialist settings do not configure the Rust engine's separate model profiles. See the [ACP backend guide](docs/acp-backend.md) for native compatibility configuration and limits.

## Optional services

The full Compose stack is opt-in. Generate a private `.env` with independent random service and datastore credentials; the command refuses to overwrite an existing configuration. Review optional provider settings before starting:

```sh
node scripts/configure-services.mjs
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
| `extensions/son-of-anton-daemon` | Private Rust engine client, optional external attachment, graph inspector and runtime setup |
| `son-of-anton-core` | Native compatibility agent, provider, checkpoint and MCP runtime |
| `son-of-anton-cli` | Interactive and headless CLI |
| `crates` | Native code graph and N-API binding |
| `services/code-graph/mcp-server` | Bundled graph MCP process |
| `services`, `son-of-anton-mcp` | Optional services and MCP integrations |
| `src`, `build` | Code OSS editor and packaging |

Contributions follow the modification tiers and validation requirements in [CLAUDE.md](CLAUDE.md). [Fork maintenance](docs/fork-maintenance.md) documents ownership and update rehearsal. Licensed under [MIT](LICENSE.txt), with original Microsoft attribution retained.
