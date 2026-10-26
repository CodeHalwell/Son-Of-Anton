# Son of Anton Shared Sessions

The built-in runtime companion for Son of Anton. It supplies the packaged Codypendent runtime, **Shared Sessions**, the shared task board, graph/knowledge commands and native council entry points. Codypendent's TUI and desktop can attach to the same daemon-owned sessions.

Trusted Unix workspaces start the bundled daemon when needed. Alternatively start Codypendent with `codypendent daemon start`, then run **Son of Anton: Open Shared Sessions** in the editor. Choose **New Session** to create a session for an open repository, or open an existing session from the list. The session ID is selectable for use in another client.

Prompts, streamed replies, approval decisions, questions, run cancellation, and available patch previews all travel through the daemon protocol. Modes are Ask, Explore, Plan, Build, and Review. Configure models in Codypendent; this extension neither provisions credentials nor executes agent tools. Disconnecting or closing the editor leaves daemon runs alive. Cancelling a run requires the explicit **Cancel Run** action.

Untrusted workspaces attach as observers. Sending prompts and resolving approvals require workspace trust. Editor context is sent only for files within the selected session's known repository. No knowledge database is opened by this client.

History is recovered through catch-up and the session-history API. The displayed transcript is bounded; unresolved approvals and questions are retained separately. Patch previews are read-only and may be truncated. Full patch review and application continue through Codypendent's existing review flow.

Anton's primary Unix chat, participants and inline assistance use this runtime by default. Task-board and council commands route to shared surfaces. Explicit native mode preserves existing local histories and legacy graph behaviour. See [the runtime and migration guide](../../docs/shared-runtime.md).

## Build and verify

```sh
npm ci
npm run typecheck
npm test
npm run build
```

To exercise a real locally built Codypendent daemon, with a deterministic loopback model fixture and isolated temporary data:

```sh
CODYPENDENT_TEST_TUI=1 CODYPENDENT_TEST_BINARY=/absolute/path/to/codypendent npm test
```

The PTY option adds the actual Rust TUI. Native tests also exercise authenticated knowledge and repository card supersession. The native test is explicitly skipped when the executable is not supplied. It creates and attaches sessions over real Unix sockets, starts a run, disconnects the issuing client, checks completion in a second client, and recovers the response in a third client. No commercial model requests are made.

`sota.daemon.socketPath` overrides daemon discovery. Otherwise the client follows `CODYPENDENT_SOCKET`, `CODYPENDENT_DATA_DIR`, `XDG_RUNTIME_DIR`, and Codypendent's platform data directory. The current transport requires a local daemon Unix socket; a remote desktop service or Windows transport is not added by this milestone.

## SDK provenance

`vendor/codypendent-protocol-1.1.0.tgz` is a self-contained distribution of Codypendent's protocol SDK. `vendor/UPSTREAM.json` records its source baseline, source digest, archive digest, and whether the export includes uncommitted SDK changes. Normal builds need no sibling checkout and make no GitHub dependency fetch.

To deliberately update the SDK from a Codypendent checkout with its SDK dependencies installed:

```sh
node scripts/sync-codypendent-protocol.mjs --source /absolute/path/to/codypendent
```

Run that command from the Son of Anton repository root, the script updates both editor extensions' dependencies and lockfiles. The SDK's MIT license is retained under `vendor/` and inside the archive.
