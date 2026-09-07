# ACP agent backend

Son of Anton uses Agent Client Protocol v1 over newline-delimited JSON-RPC on stdio. The IDE, CLI and optional ACP service share the transport and process runtime in `son-of-anton-core/src/acp`. The service consumes a generated copy; `node scripts/sync-acp-runtime.mjs --check` prevents it drifting from core.

This replaces the old private `acp/session.*` protocol. Connections negotiate `initialize`, then use `session/new`, `session/prompt`, `session/update`, `session/cancel` and `session/request_permission`. The [ACP initialization specification](https://agentclientprotocol.com/protocol/initialization) defines the capability negotiation. The former `/rpc` + `/events` agent transport was removed: standard [ACP HTTP transport remains a draft](https://agentclientprotocol.com/protocol/transports). The optional service's HTTP/SSE API is an application facade over stdio agents.

## Built-in agents as ACP servers

After building the core and CLI:

```sh
node son-of-anton-cli/dist/cli.js acp --agent anton-code
```

An ACP client must write protocol messages to stdin; ordinary text input is not a prompt in this mode. Stdout is reserved for protocol frames and diagnostics go to stderr. The default agent is `anton`. Available session modes are `anton`, `anton-code`, `anton-test`, `anton-security`, `anton-docs`, `anton-e2e`, `anton-ci`, `anton-pr`, `anton-moderniser`, and `anton-review`. Clients can select another agent using `session/set_mode` between turns.

Each session owns its working directory, stack, plan, history and cancellation state. Creating another session does not replace an active conversation. The server accepts an absolute `cwd` and standard MCP stdio descriptors in `session/new`, and makes those MCP tools available to native agent loops in that session when the workspace is trusted. The same provider credentials and per-agent model settings used by the CLI apply. Configure the matching model if your credentials are for a provider other than the specialist's default. Text, resource links and embedded text resources are supported; image/audio prompts and session loading are not advertised. Sessions are in memory, with a limit of 16 per server process; reconnecting starts a new session.

Writes, commands and side-effecting MCP tools request permission through the connected ACP client. Only the explicitly selected offered allow option approves a request. Cancellation, an unanswered permission or disconnection denies it. The agent server disables external ACP routing inside its own stack to prevent an accidental recursive `sota acp` launch. Workspace hooks still require explicit workspace trust.

## Route IDE or CLI specialists to external agents

Install and authenticate the adapters you intend to use. Discovery never starts an adapter or logs in. An explicitly configured `npx`/`uvx` package launch can download its pinned package on first use. Examples of upstream launch commands are:

| Agent | Command | Source |
|---|---|---|
| Gemini CLI | `gemini --acp` | [Gemini ACP mode](https://geminicli.com/docs/cli/acp-mode/) |
| Codex adapter | `codex-acp` | [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp) |
| Claude Agent adapter | `claude-agent-acp` | [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) |
| Built-in specialist | `sota acp --agent anton-code` | Build/install this repository's CLI, or use an absolute Node and CLI path |

A plain `codex` invocation and Gemini's `--output-format stream-json` are not ACP servers. Older Gemini builds may use `--experimental-acp`; check the installed version's help. Choose adapters and versions explicitly using their upstream installation instructions.

Configure user settings in the IDE, or the same flat keys in `~/.son-of-anton/config.json` for the CLI:

```json
{
  "sota.acp.agents": [
    { "id": "codex", "command": "codex-acp", "args": [] },
    { "id": "gemini", "command": "gemini", "args": ["--acp"] }
  ],
  "sota.agents.anton-code.acpAgent": "codex",
  "sota.agents.anton-test.acpAgent": "codex",
  "sota.agents.anton-review.acpAgent": "gemini",
  "sota.acp.maxProcesses": 4,
  "sota.acp.maxQueue": 32
}
```

Each specialist except the coordinating `anton` supports an `acpAgent` assignment. An empty assignment uses its native implementation. Reload the IDE window after changing these settings. Commands are user/machine settings; execution requires a trusted workspace. The CLI uses its existing workspace trust decision (`SOTA_TRUST_WORKSPACE=1`) and the run's approval policy. Unattended CLI surfaces without an approval gate deny permission requests. The IDE offers one-time permission choices in a modal with the proposed tool details.

Optional `env` supplies environment overrides; prefer inherited provider credentials over committing secrets to config. Optional `authMethodId` invokes only that explicitly configured, advertised method after initialization. Otherwise the adapter uses its existing login state. External agents own their model configuration: the native chat model picker does not change an external agent's model.

Native agent loops preserve the MCP server’s input schema, including required fields and nested constraints. Tool discovery uses the client’s cached listing once per turn; cancelled MCP calls send `notifications/cancelled` and remove their pending request. Tools without a read-only declaration require host approval, and an approval arriving after cancellation cannot execute the call. MCP servers must be trusted before their executables start. External ACP adapters manage their own MCP configuration unless descriptors are supplied through the ACP service.

## Runtime limits and efficiency

The runtime keeps one process/session per active specialist conversation and reuses it for follow-ups. It serializes overlapping turns for that conversation while allowing independent conversations to run up to the process limit. Defaults are four processes and 32 queued requests; overflow is rejected. Idle processes expire after five minutes, and an idle process can be evicted to serve new work. When a conversation's process has been recreated, the host supplies a bounded recent-history snapshot. This is context recovery, not a durable ACP `session/load` implementation.

A turn deadline includes queue time, initialization and prompting. The default is five minutes. Waiting for a user permission pauses this budget and has a separate ten-minute limit; overlapping permission requests resume the budget only when all have resolved. Cancellation sends `session/cancel`; an agent that ignores it gets two seconds to finish before its process group is terminated. Failed prompts are never automatically replayed. Explicit subsequent user turns may start a new process. Shutdown closes active work and queued requests, including child processes. Windows launches support command shims and terminate owned process trees with bounded `taskkill` cleanup.

Protocol frames are capped at 4 MiB; pending requests and incoming requests are capped at 128 each. Output queues are bounded. UTF-8 characters split across pipe chunks remain intact. One notification handler per process replaces the old accumulating per-session listeners.

ACP tool updates flow to the existing chat and task surfaces. Completed edit/delete operations with workspace-contained locations contribute reported file changes to task results. Review and security result parsers remain active when routing those specialists through ACP; malformed review output is not approval.

ACP v1 does not guarantee provider billing or token usage reports. External executions are marked unmetered in task metrics, not free. Native provider spend caps cannot account for an external agent's undisclosed spend; configure provider/adapter limits separately. The protocol client does not advertise filesystem or terminal proxy capabilities: external agents execute their own tools and manage their own sandbox. Permission callbacks govern requests they actually make; they are not an operating-system sandbox for an arbitrary executable.

## Connection diagnostics

Run **Anton: Check ACP Connections** to probe configured IDE routes without sending a model prompt. The JSON distinguishes startup, initialization, session creation, advertised authentication methods and modes. Session readiness does not prove that a billed model turn can complete.

```sh
sota acp-doctor
sota acp-doctor --agent codex-cli --file .son-of-anton/agents/acp-agents.json
sota acp-doctor --agent codex-cli --live
```

The optional live probe requests a minimal text response, denies every tool permission and closes its owned process afterward. It can consume provider quota. Missing executables, failed handshakes and prompt failures remain distinct from successful results, and configured environment secrets are redacted. Configure adapters and specialist assignments separately: a built-in `sota acp` server still uses its CLI provider settings and does not recursively delegate to an external ACP server. Text-only subscription transports cannot execute host tool requests; use an ACP assignment for tool-capable external execution.

## Optional HTTP service

For local development, build with Node 22:

```sh
npm --prefix son-of-anton-core run build
node scripts/sync-acp-runtime.mjs
npm --prefix services/acp-client ci
npm --prefix services/acp-client run build
PROJECT_PATH="$PWD" node services/acp-client/dist/index.js
```

Set `SOTA_SERVICE_TOKEN` in the environment first. The service binds to loopback by default. `ACP_PORT` defaults to 3300; `ACP_HOST`, `ACP_MAX_PROCESSES` and `ACP_MAX_QUEUE` override the bind and runtime limits. `ACP_CONFIG_PATH` overrides `.son-of-anton/agents/acp-agents.json` beneath `PROJECT_PATH`. Registry entries describe installed agents; registration is not a claim that an adapter is installed or authenticated. Invalid reloads retain the previous valid registry.

The Docker image contains the client service; install the selected adapter executables and their credentials into your own derived image. Host executables do not become available inside a container. The supplied Compose workspace mount is read-only; use a deliberately writable isolated workspace if container agents must edit it. Docker services remain opt-in.

| Endpoint | Behavior |
|---|---|
| `GET /health` | Liveness, no agent launch |
| `GET /ready` | Authenticated configuration status and runtime counters; does not claim live provider connectivity |
| `GET /agents` | Descriptors without environment secrets |
| `GET /agents/:id/capabilities` | Bounded live initialization probe, cached for one minute; provider readiness remains unchecked |
| `POST /sessions` | Allocate `{agentId, cwd?, timeout?, mcpServers?, requestPermissions?}`; starts idle |
| `POST /sessions/:id/messages` | `{message, context?, stream?}`; starts or continues a prompt |
| `POST /sessions/:id/cancel` | Cancel the active prompt |
| `DELETE /sessions/:id` | Release the local session and process |
| `POST /dispatch` | `{taskId, protocol:"acp", agentId, task, context?, timeout?, stream?}`; bounded one-shot execution and cleanup |
| `GET /permissions` | Outstanding permission requests |
| `POST /permissions/:id` | `{optionId}` selects an offered option; `{}` cancels; expired requests cannot be reused |
| `GET /metrics` | Aggregate process, queue, reuse and completion counters |

All endpoints except health and metrics require `Authorization: Bearer <SOTA_SERVICE_TOKEN>`. HTTP bodies are capped at 1 MiB and ten seconds. Dispatch results are capped at 8 MiB/20,000 events. The service has 128 local sessions, expiring after 30 idle minutes. Slow event consumers are disconnected when their buffered output exceeds 1 MiB; closing a response cancels its work.

With `stream:true`, responses use SSE events (`message`, `tool_call`, `plan`, `progress`, `permission`, `complete`, `error`; dispatch also sends `result`). Permission requests require `requestPermissions:true` when creating the session or dispatching. Without that option, the service returns the cancelled permission outcome. Interactive consumers resolve each request through the permission endpoint; unanswered requests expire after two minutes. Permission policy is never automatically changed to allow-all.

Migration: `POST /sessions` no longer starts a task implicitly. Send a message after allocation, or use `/dispatch`. The old `tools` name list and `maxTokens` session overrides are rejected rather than silently ignored; use standard MCP descriptors and the agent's model configuration. ACP v1 has no turn pause operation; cancel, then send a new prompt to continue.

## Verification

Offline tests launch a real fixture executable implementing only standard ACP methods. They cover bidirectional IDs, split UTF-8, immediate completion, initialization failure, process/session reuse, bounded concurrency and queueing, deadlines, cancellation, permission cancellation, malformed/oversized frames, crashes, cleanup, HTTP auth/body limits, streamed dispatch, and permission resolution. CLI handler tests cover separate working directories and histories, session capacity and mode validation. Factory tests prove ACP routing avoids direct model calls and preserves review/security verdicts. A separate real MCP fixture verifies native chat and code-task tool discovery, schema preservation, approval refusal, cancellation and connection reuse.

Local validation: 99 core tests, 17 CLI tests, 383 extension tests, 11 ACP service tests and 24 browser UI scenarios passed. An authenticated prompt through the rebuilt `sota acp --agent anton-docs` CLI completed using the existing Claude Code subscription, with streamed response text, `end_turn`, no failed runtime turns and zero processes remaining after shutdown. Two native-app Claude Code responses were also inspected; see [the live chat check](evaluations/live-chat-2026-09-07.md) for rendering fixes and completed native sidebar verification.

The installed Gemini CLI 0.46.0 advertises `--acp`, but its live initialization did not complete during the bounded local probe; it is not marked interoperable from that probe. The third-party Codex and Claude ACP adapters were not installed on this machine. Their authenticated turns and cross-platform process cleanup remain unverified.

System skills, plugin components, and MCP configurations now share a discovery catalog across the IDE and CLI. See [system integrations](system-integrations.md) for selection, authentication boundaries, and verified capabilities.
