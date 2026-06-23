# Son of Anton

## Project Overview

Son of Anton is an AI-native code editor forked from VS Code (Code OSS). It integrates Claude-powered agents directly into the development workflow through a graph-based code intelligence layer, semantic search, and the Model Context Protocol (MCP).

**Who it's for:** Developers who want deep AI assistance that understands their entire codebase — not just the open file.

**What it does:** Provides orchestrated AI agents (orchestration, code generation, review, refactoring, testing, security, docs, CI, PR generation) backed by a code knowledge graph and vector search, all running locally alongside the editor.

> This repository is a **monorepo**. The IDE fork, the agent runtime, the CLI, the MCP servers, the backend services, and the Rust code-graph engine all live here. (Earlier revisions of this file described some of these as separate repositories — they have since been consolidated.)

## Architecture Decisions

### Services-first, fork-second

All AI capabilities are built as standalone services that communicate through well-defined protocols. The VS Code fork is a thin integration layer. This minimises merge conflicts when pulling upstream updates and allows services to be developed and tested independently.

### Technology choices

- **FalkorDB** — Graph database for code structure (AST nodes, call graphs, dependency relationships). Chosen for its Redis-compatible protocol, Cypher query support, and low memory footprint.
- **Qdrant** — Vector database for semantic code search. Chosen for its gRPC support, filtering capabilities, and efficient HNSW indexing.
- **Tree-sitter** — Incremental parsing for real-time code intelligence. Chosen because it's fast, supports 100+ languages, and produces concrete syntax trees.
- **LSIF/SCIP** — Language Server Index Format for precise cross-references (go-to-definition, find-references). Complements Tree-sitter's structural parsing with type-aware analysis.
- **MCP (Model Context Protocol)** — Standard protocol for exposing tools to LLMs. Allows agents to query the code graph and vector store through a uniform interface.
- **Claude (Anthropic)** — Primary LLM, chosen for extended thinking, tool use, and routing between Opus/Sonnet/Haiku by task complexity. The runtime is provider-pluggable and also supports OpenAI, Azure AI Foundry, AWS Bedrock, and Google Gemini.
- **Rust** — The performance-critical code-graph engine (`crates/`) is written in Rust and exposed to Node via N-API bindings.

## Repository Structure

This monorepo combines the VS Code fork with the Son of Anton AI stack.

### Inherited from VS Code (Code OSS)

| Path | Purpose |
|---|---|
| `src/vs/base/` | Foundation utilities and cross-platform abstractions |
| `src/vs/platform/` | Platform services and dependency injection infrastructure |
| `src/vs/editor/` | Text editor core (language services, syntax highlighting) |
| `src/vs/workbench/` | Main application workbench (browser + desktop) |
| `src/vs/code/` | Electron main process implementation |
| `src/vs/server/` | Server implementation |
| `build/`, `test/`, `scripts/`, `resources/`, `cli/`, `remote/` | Build tooling, tests, dev scripts, resources, Rust CLI, remote server |
| `extensions/` | Built-in extensions that ship with the editor |

### Son of Anton additions

| Path | Purpose |
|---|---|
| `src/vs/sessions/` | **Agentic Window** — a dedicated top-level workbench layer for agent session workflows. Sits alongside `vs/workbench`; may import from it but **never** the reverse. See `src/vs/sessions/README.md`. |
| `extensions/son-of-anton/` | The primary IDE extension: chat surface, agents, code graph, sandbox, dashboards, inline edits, MCP integration. Registers the `anton` chat participant and specialists. |
| `extensions/son-of-anton-theme/` | Default Son of Anton color theme. |
| `son-of-anton-core/` | TypeScript agent runtime library (`son-of-anton-core`). Contains the agent stack, LLM clients, model router, tool registry, MCP client, persistence, and credential handling. Consumed by the extension and the CLI. |
| `son-of-anton-cli/` | Standalone headless/TUI CLI (`son-of-anton-cli`) built on `son-of-anton-core`. Packages into native binaries (macOS arm64, Linux x64, Windows x64). |
| `son-of-anton-mcp/` | MCP server definitions (`servers/`: database, deployment, playwright, tickets), an MCP `gateway/`, and `config.json` registry of trusted internal servers. |
| `son-of-anton-graph/` | Documentation for the graph stack. |
| `services/` | Containerised backend services (see below). |
| `crates/` | Rust workspace for the code-graph engine: `sota-codegraph-core`, `sota-codegraph-napi` (N-API bindings), `sota-codegraph-cli`. |
| `docs/` | Architecture and planning docs (`architecture.md`, `agents.md`, modification audits, plans). |
| `.son-of-anton/` | Runtime config: agent definitions, `hooks.json`, `routing.json`, `supply-chain.json`, security findings. |

### Key documentation

- `docs/architecture.md` — How the chat surface, agent stack, tool execution, and persistence fit together.
- `docs/agents.md` — Agent-by-agent reference.
- `src/vs/sessions/README.md` — The agentic window layer and its layering rules.
- `AGENTIC_PLATFORM_PLAN.md` — Platform roadmap.

## Backend Services

Services live in `services/<service-name>/`, each with its own `Dockerfile`, `package.json`, `src/`, and `test/`. Shared code lives in `services/_shared/` and `services/_lib/` (metrics, tracing); individual services vendor it via a `_lib` symlink. Orchestrated via `docker-compose.yml`.

| Service | Port | Description |
|---|---|---|
| FalkorDB | 6379 | Code knowledge graph storage |
| Qdrant | 6333 / 6334 | Vector search for semantic code queries |
| `indexer` | 8080 | Parses and indexes codebases into the graph and vector store |
| `lsif` | 8081 | Language Server Index Format processor |
| `mcp-gateway` | 3100 | Central MCP server for agent tool access (code graph) |
| `model-router` | 3200 | Routes LLM requests to the appropriate model |
| `checkpoints` | 3201 | Workspace checkpoint and rollback service |
| `walkthrough` | 3202 | Guided walkthrough generation |
| `acp-client` | 3300 | Agent Communication Protocol client |
| `build-dag` | 3301 | Build dependency graph analysis |
| `context-sanitiser` | 3302 | Strips secrets and sensitive data from LLM context |
| `spec-pipeline` | 8090 | Specification-driven development pipeline |
| `penetration-tester` | 8092 | Automated security testing via OWASP ZAP |
| `background-tasks` | 8093 | Long-running async agent tasks |
| `visual-regression` | 8094 | Screenshot diffing for UI changes |
| MCP servers | 3102–3104 | `mcp-database`, `mcp-deployment`, `mcp-tickets` |
| `code-graph` | — | Self-contained code-graph stack (indexer + MCP server + sample extension) |
| Jaeger (optional) | 16686 / 4318 | Cross-service tracing (`--profile tracing`) |

## Agent Stack

The agent runtime lives in `son-of-anton-core/src/agents/` and is shared (built once per extension activation) between the chat panel and sidebar.

- **Orchestrator** (`anton`) — the always-on entry agent that plans and routes.
- **In-stack specialists** with full `BaseAgent` lifecycle: code, test, e2e, security, docs, ci, pr, moderniser.
- **Spec pipeline** (`anton-spec`) — driven by `SpecPipelineManager` (requirements → task decomposition → design), surfaced via chat routing rather than a long-lived agent.
- Supporting pieces: `MetricsTracker`, `ProjectMemory`, `SpecialistMemory`, `ReviewAgent`, `AgentStackFactory`.

Requests flow: **Webview → ChatSession → AgentBridge → AgentStack**, with results streamed back as typed `AgentEvent`s (plan-proposed, subtask-started/token/completed/failed, token, final). The webview never touches secrets, the filesystem, or child processes — every privileged call is a validated `postMessage` to the extension host.

## Modification Tier Policy

All changes to this codebase are classified into tiers based on merge conflict risk:

### Tier 1 — New files alongside core (target: 75% of changes)
- New services in `services/`
- New extensions in `extensions/`
- New files in `src/vs/sessions/`
- New code in `son-of-anton-core/`, `son-of-anton-cli/`, `son-of-anton-mcp/`, `crates/`
- Configuration files, documentation
- **Zero merge conflict risk.** No review gate beyond CI.

### Tier 2 — Hooks into existing code (target: 20% of changes)
- Adding imports or extension points to existing VS Code modules
- Registering new contributions in existing registries
- Adding new menu items, commands, keybindings
- **Low merge conflict risk.** Human review required.

### Tier 3 — Direct core patches (target: <5% of changes)
- Modifying existing VS Code source files
- Changing build scripts or configuration
- Altering existing UI components
- **High merge conflict risk.** Requires written justification and senior engineer review.

Every PR description must state which tier of modification it contains.

## Coding Standards

### Languages
- **IDE and extensions:** TypeScript
- **Agent runtime, CLI, services:** TypeScript (Node.js) for all production code. Early service stubs under `services/*` may use JavaScript `index.js` files, but must be migrated to TypeScript before the service is considered stable or production-ready.
- **Code-graph engine:** Rust (`crates/`), exposed to Node via N-API.
- **MCP servers:** TypeScript or Python

### Toolchain
- Node.js version is pinned in `.nvmrc` (currently **22.22.0**).
- IDE source is compiled with the gulp/`tsgo` build pipeline (see below) — **never** `npm run compile` for type-checking iterations.
- `son-of-anton-core` and `son-of-anton-cli` build with plain `tsc -p tsconfig.json` (or `npm run watch`).
- Services build/test independently within their own directory.

### Formatting
- Use tabs for indentation (matching upstream VS Code convention)
- Use Prettier and ESLint with the project's existing configuration
- Use single quotes for internal strings, double quotes for user-facing localised strings

### Naming
- PascalCase for types, enums, classes
- camelCase for functions, methods, properties, local variables
- Use whole words — no abbreviations unless universally understood

### File organisation
- Services live in `services/<service-name>/`, each with its own `Dockerfile`, `package.json`, and health endpoint.
- The agent runtime lives in `son-of-anton-core/`; the standalone CLI in `son-of-anton-cli/`.
- MCP server definitions live in `son-of-anton-mcp/`.

### Testing
- Every new function needs tests
- Use `describe` and `test` blocks consistently with existing patterns
- Prefer snapshot-style `assert.deepStrictEqual` over many small assertions
- Integration tests for services must run against the Docker Compose stack

## Forbidden Patterns

- **No direct network calls to Microsoft domains** — all telemetry and update endpoints must be removed or redirected
- **No telemetry without explicit opt-in** — respect user privacy
- **No storing secrets in source code** — use environment variables and `.env` files (never committed; see `.env.example`)
- **No Tier 3 modifications without written justification** — document why the change can't be Tier 1 or 2
- **No agent-generated code merged without review agent passing** — all AI-authored code must pass automated review
- **No extension installs outside the allowlist** — see `extensions-allowlist.json`

## Agent Instructions

### Model routing

Routing is configured in `.son-of-anton/routing.json` and the `model-router` service. The default capability tiers:

| Task type | Model | Rationale |
|---|---|---|
| Orchestrator planning, complex reasoning | Opus | Highest capability |
| Code generation, refactoring, test writing | Sonnet | Best balance of capability and cost |
| Exploration, quick completions, summaries | Haiku | Fastest, cheapest |

### Token budget guidance
- Use graph context routing to include only relevant code in prompts
- Structure prompts for maximum cache hit rates: system prompt (static) > CLAUDE.md (static per session) > graph context (semi-static) > dynamic content
- Break-even for prompt caching is 2 API calls — always enable it

### Autonomy guidelines
- **Proceed autonomously:** Tier 1 changes, formatting fixes, test additions, documentation updates
- **Ask for human input:** Tier 2+ changes, architectural decisions, ambiguous requirements, security-sensitive changes
- **Error handling:** Max 3 retries on any operation, then escalate to human

### Rate limits
- Max 5 concurrent API requests
- Max 30 requests per minute per agent
- Configurable spend cap per session (kill switch)

## PR Process

1. All PRs require CI to pass
2. **Tier 1 changes:** Agent review sufficient
3. **Tier 2 changes:** Human review required
4. **Tier 3 changes:** Senior engineer review required
5. Every PR description must state which tier of modification it contains
6. Every PR must include a test plan

## Building the IDE

The IDE follows the upstream VS Code build pipeline. Validate TypeScript changes **before** running tests or declaring work complete.

```bash
# Install dependencies (Node version per .nvmrc)
npm install

# Watch build (client transpile + client + extensions)
npm run watch

# Type-check src/ without emitting (preferred quick check)
npm run compile-check-ts-native

# Type-check built-in extensions
npm run gulp compile-extensions

# Layering rules check
npm run valid-layers-check
```

- **NEVER** run tests if there are compilation errors.
- **NEVER** use `npm run compile` just to type-check.
- Unit tests: `scripts/test.sh` (`--grep <pattern>` to filter). Integration tests: `scripts/test-integration.sh`.

## Docker Compose Quick Reference

```bash
# Copy env template first
cp .env.example .env   # then fill in ANTHROPIC_API_KEY, etc.

# Start all backend services
docker compose up -d

# Check service health
docker compose ps

# View logs
docker compose logs -f

# Start with cross-service tracing (Jaeger)
docker compose --profile tracing up -d

# Tear down and remove all data
docker compose down -v

# Test FalkorDB
docker compose exec falkordb redis-cli GRAPH.QUERY son-of-anton "RETURN 1"

# Test Qdrant
curl http://localhost:6333/readyz
```

## Repository Map

All of the following now live in this monorepo (formerly described as separate repos):

| Component | Location | Purpose |
|---|---|---|
| Main IDE | `src/`, `extensions/`, `build/` | VS Code fork + agentic window + Son of Anton extension |
| Agent runtime | `son-of-anton-core/` | Agent stack, LLM clients, model router, tools, MCP client |
| CLI | `son-of-anton-cli/` | Headless/TUI agent CLI built on the core runtime |
| MCP servers | `son-of-anton-mcp/` | MCP server definitions and gateway |
| Backend services | `services/` | Containerised graph, index, routing, security, and task services |
| Code-graph engine | `crates/` | Rust code-graph core + N-API bindings + CLI |
| Graph stack docs | `son-of-anton-graph/` | Graph stack documentation |
