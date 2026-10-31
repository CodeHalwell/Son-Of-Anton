# Shared runtime and product boundary

Son of Anton is the Code OSS IDE. Codypendent is the Rust daemon, Ratatui TUI, and Tauri desktop application. Each product bundles its own pinned engine and owns its state and lifecycle. Explicit external attachment can observe the same durable sessions. Beadsmith is a retired design donor and remains unchanged. See [independent products](independent-products.md) for the implemented boundary and remaining convergence work.

## What belongs where

| Source | Retained strengths | Integration |
| --- | --- | --- |
| Son of Anton | Editor, chat UI, personas, context selection, inline diff review, VS Code integration, native installers | Primary chat, participants, inline assistance, task board, council entry points and graph commands use its privately bundled Rust engine; external attachment is optional |
| Codypendent | Durable sessions, model drivers, authenticated transport, policy and approvals, worktrees, workflows, promotion, graph evidence, governed knowledge | Engine implementation reused through pinned builds; each product's runtime owns its sessions, and Codypendent's TUI and desktop remain first-class clients |
| Beadsmith | Reviewable increments, timelines, memory retention and provenance, explicit success criteria | Reuse Codypendent's checkpoint/patch/evidence machinery; preserve interleaved activity and distinguish run completion from validation success |

The reusable Node client and bounded activity projection live in `codypendent/sdk/protocol`, alongside the schema-generated wire contracts. Anton vendors a versioned SDK archive and the Rust runtime's build inputs, with hashes and source provenance. An ordinary Anton build needs no sibling checkout. There is no third orchestration service or new shared repository.

## Default behaviour

`sota.runtime.backend` defaults to `auto`: Anton's privately bundled Rust engine on Linux/macOS and the native compatibility runtime on Windows. The legacy `codypendent` value also selects the Rust engine, while `native` selects compatibility. That engine choice is fixed for a window's lifetime; changing it requires Reload Window.

`sota.daemon.connection` separately defaults to `local`. Anton launches with the
`son-of-anton` product profile, using only `SON_OF_ANTON_*` path overrides.
`external` explicitly uses Codypendent discovery; a nonempty
`sota.daemon.socketPath` explicitly chooses a custom external endpoint. External
runtimes are never started, restarted, or configured by Anton. Every client uses
the captured endpoint, and bookmarks are scoped to its identity. Choose **Use
Local Agent Runtime** or **Connect to Codypendent** to switch deliberately.

In shared mode:

- The original composer and VS Code participants submit to daemon-owned sessions. Closing a panel or switching conversations only stops observation. Stop/Cancel explicitly cancels the relevant daemon run.
- The editor keeps navigation bookmarks. The daemon retains the transcript, run receipts, approvals, questions, checkpoints and measured usage. Pending drafts clear only after a matching durable acceptance; an interrupted mutation is never automatically retried.
- Shared Sessions lists sessions in the selected runtime. Codypendent-owned sessions appear only after explicit external attachment. Open Shared Conversation links a session into the original editor chat without copying its ledger.
- Inline edits and completions use internal daemon sessions in Ask mode. Cancellation targets their own run; incomplete or truncated output cannot be applied as a completed edit. Existing document-version and diff-review checks remain in force.
- The shared task board reads and writes repository blackboard items through the protocol. Superseded card revisions cannot be overwritten. Moving a card coordinates work; it neither executes a worker nor establishes test success.
- Council commands use the local engine's council service and durable reports through Anton's bundled Agent Terminal. Model/provider setup stays in Anton's setup wizard and chat forms. External model configuration and council execution stay in the owning application. Legacy MCP processes and hooks are not started by the Rust editor harness.
- Graph commands read/build the same structural graph used by Rust workers. The inspector supports exact symbol drill-down and validated source navigation. Bounded results preserve edge confidence, source evidence and freshness information. A graph page does not establish complete impact, test coverage or semantic retrieval.
- Knowledge browsing uses protocol 1.10 `ReadKnowledge`. The server checks session ownership and daemon-store authority and derives scopes from the stored session. The webview cannot name arbitrary scope keys. Memory requests remain subject to the daemon's curation and secret filters.

Untrusted workspaces can observe an already-running daemon. They cannot start the bundled runtime, submit prompts, resolve approvals, change cards or run inline assistance.

## Migration and compatibility

Existing local Anton histories are preserved. A local history without a shared session link is visibly identified and cannot silently become an empty shared session. Continue it by selecting `native` and reloading, or create/link a shared conversation. No automatic database import, destructive conversion or historical replay into a new agent run occurs.

Legacy shared-session links without runtime identity remain preserved. Local
mode refuses to attach them to Anton's new private store. Select the original
external runtime to reopen them; successful explicit attachment records the
endpoint identity. Existing identified links fail closed after an endpoint
change instead of creating a replacement session in another store.

The native compatibility stack and embedded graph remain available for the existing editor features and Windows. This is a compatibility boundary, not a second executor for the same shared request. Provider and tool settings belong to the runtime owning the session: Anton's private configuration in local mode, or the external runtime's configuration after attachment. Native compatibility provider and tool settings apply only to native runs; they do not automatically configure the private Rust engine.

Codypendent's four knowledge list views now use the authenticated daemon API. Some existing learning mutation, document replica and graph/workflow projection paths still use local SQLite. Local model/provider configuration and council definitions also remain native files. This change does not claim to remove every local store adapter.

## Operational limits

The SDK rejects pending requests on disconnect and bounds individual requests (15 seconds by default). Connection/restoration has a separate 45-second connection bound and a 30-second history-recovery bound. Invalid sequence gaps fail closed; history recovery failure blocks session mutations until reconnection. Negotiated protocol checks reject unsupported model-readiness and knowledge commands with an update instruction.

The shared display retains at most 300 rows, 64,000 characters per row and 256,000 characters in aggregate, with explicit truncation. Full history stays in the daemon. Knowledge replies are at most 100 cards and 8 MiB per page; native adapters cap their collection at 10,000 cards. Underlying legacy store queries can still scan more rows before paging, so very large knowledge stores need additional profiling.

Linux sandbox discovery probes actual confinement. An installed `bwrap` executable is insufficient when the host disables namespaces; unavailable confinement never falls back to unrestricted execution.

## Builds and verification

Use Node 22.23.4 and the repository's Rust toolchains. After changing the shared implementation:

```sh
node scripts/sync-codypendent-protocol.mjs --source /path/to/codypendent
node scripts/sync-codypendent-runtime.mjs --source /path/to/codypendent
node scripts/verify-codypendent-vendor.mjs
```

Review both vendor manifests, including `includesLocalChanges`, rather than treating the recorded base commit as an exact clean-source claim. Build the runtime with `node scripts/build-codypendent-runtime.mjs`; release artifacts include the confined UI-worker launcher, native file hashes and a sealed Node 22.23.4 tree for component workers. Node archives are checked against pinned official checksums and retain their licenses. `CODYPENDENT_NODE_ARCHIVE` can supply the identical archive offline. Both debug and release runtimes must be built from the verified source archive; prebuilt binary overrides are rejected. Runtime and installer guards require the independent Son product profile.

The native compatibility graph normally uses ort-sys's pinned ONNX distribution. Offline Linux builders may explicitly supply ONNX Runtime 1.22.0 through `ORT_LIB_LOCATION` and `ORT_PREFER_DYNAMIC_LINK=1`, plus `ORT_LICENSE_FILE` and `ORT_NOTICES_FILE`. The builder verifies the SDK version and bundles the libraries, notices and hashes with an origin-relative loader path. It does not require a machine-wide ONNX installation.

Run the SDK/editor/desktop checks, `npm run gulp compile-extensions`, and the extension tests. `CODYPENDENT_TEST_BINARY` selects an actual Rust daemon for editor handoff tests; `CODYPENDENT_TEST_TUI=1` adds a real terminal client in a PTY. Codypendent's `apps/desktop` `test:native` opens an actual Tauri window with WebKitGTK WebDriver, closes it during a run, and verifies replay and authenticated knowledge after reopening. The native tests use deterministic loopback models and no paid API credentials.

See [production-readiness.md](production-readiness.md) for observed evidence and remaining release gates. Build registration and installer changes require normal human review before merge; nothing here merges or publishes a release.
