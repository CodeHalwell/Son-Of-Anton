# Son of Anton Agent Runtime

The built-in agent engine for Son of Anton. It supplies a private pinned Rust runtime, **Shared Sessions**, the task board, graph inspector, knowledge commands and council entry points. Son of Anton runs without a Codypendent installation.

Trusted Unix workspaces start the privately bundled daemon when needed. Choose **New Session** to create a session for an open repository, or open an existing session from the selected runtime's list. To deliberately share Codypendent-owned sessions, choose **Son of Anton: Connect to Codypendent** and start Codypendent separately. **Use Local Agent Runtime** returns to Anton's own storage and engine. An unavailable external runtime is never started by Anton.

Prompts, streamed replies, approval decisions, questions, run cancellation, and available patch previews all travel through the daemon protocol. Modes are Ask, Explore, Plan, Build, and Review. Configure Anthropic, OpenAI, or Gemini model IDs through Anton's setup wizard or chat forms. Keys live in extension SecretStorage and reach only the private engine environment; saving configuration makes no model request. Credential changes restart only an idle engine. An external runtime's owner configures its models. Disconnecting or closing the editor leaves runs alive; cancellation requires the explicit **Cancel Run** action.

Untrusted workspaces attach as observers. Sending prompts and resolving approvals require workspace trust. Editor context is sent only for files within the selected session's known repository. No knowledge database is opened by this client.

History is recovered through catch-up and the session-history API. The displayed transcript is bounded; unresolved approvals and questions are retained separately. Patch previews are read-only and may be truncated. Full patch review and application use the owning runtime's review flow: Anton's bundled Agent Terminal for local sessions, or the external runtime's application after attachment.

Anton's primary Unix chat, participants and inline assistance use this runtime by default. Task-board and council commands route to shared surfaces. Explicit native mode preserves existing local histories and legacy graph behaviour. See [the runtime and migration guide](../../docs/shared-runtime.md).

## Repository workflows

**Son of Anton: Browse Repository Workflows** reads the selected runtime's catalog
for a canonical local repository. It shows actual definition sources, versions,
digests, input declarations, and catalog diagnostics. Each input accepts a JSON
value; domain-specific types do not imply a schema or invented defaults.
Starting requires workspace trust and an explicit action. A changed definition
requires catalog refresh and review before a new start.

The monitor retains the most recent 20 launch receipts for that repository and
endpoint and displays up to 100 recorded nodes per snapshot. Controls apply only
to those receipts and displayed node identities. Pause is cooperative, cancel is
terminal, and retry resets the chosen node and its downstream dependants. A
recorded completion is not evidence that tests passed.

Pending start payloads use extension SecretStorage; ordinary workspace bookmarks
contain only receipt metadata. Unsent JSON drafts remain in panel memory: hiding,
polling, and catalog refresh preserve them, while closing the panel can discard
them. Unknown start outcomes retain the same definition,
inputs, and idempotency key for explicit **Reconcile Start**, including after panel
closure. Reopening never launches work automatically. Closing stops observation
without cancelling durable work. Catalogs require protocol 1.12; an older
external runtime remains unavailable until its owner upgrades it.

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

`sota.daemon.connection` defaults to `local`, using `son-of-anton` platform directories and only `SON_OF_ANTON_SOCKET`, `SON_OF_ANTON_DATA_DIR`, and `SON_OF_ANTON_CONFIG_DIR` overrides. `external` deliberately selects Codypendent discovery. A nonempty `sota.daemon.socketPath` is an explicit custom external connection. Session bookmarks and sidebar navigation are scoped to the captured endpoint; legacy links require explicit attachment to their original runtime. The current transport requires a local Unix socket; Windows retains the native compatibility runtime.

## SDK provenance

`vendor/codypendent-protocol-1.1.0.tgz` is a self-contained distribution of Codypendent's protocol SDK. `vendor/UPSTREAM.json` records its source baseline, source digest, archive digest, and whether the export includes uncommitted SDK changes. Normal builds need no sibling checkout and make no GitHub dependency fetch.

To deliberately update the SDK from a Codypendent checkout with its SDK dependencies installed:

```sh
node scripts/sync-codypendent-protocol.mjs --source /absolute/path/to/codypendent
```

Run that command from the Son of Anton repository root, the script updates both editor extensions' dependencies and lockfiles. The SDK's MIT license is retained under `vendor/` and inside the archive.
