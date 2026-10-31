# Independent Son of Anton and Codypendent products

Son of Anton is the editor-first, multi-agent Code OSS IDE. Codypendent is the
Rust TUI and Tauri desktop application. Each product ships a pinned copy of the
engine and owns its configuration, credentials, state, socket, and upgrades.
Beadsmith is a retired reference for interaction patterns, not a runtime dependency.

## Implemented boundary

- `sota.daemon.connection` defaults to `local`. Normal Unix startup launches only
  the verified bundled engine with `AGENT_RUNTIME_PRODUCT=son-of-anton`.
- The Rust engine and Node SDK resolve `son-of-anton` and `codypendent` profiles.
  Anton reads `SON_OF_ANTON_DATA_DIR`, `SON_OF_ANTON_CONFIG_DIR`, and
  `SON_OF_ANTON_SOCKET`; Codypendent reads its existing `CODYPENDENT_*` overrides.
  Overrides for the other product do not change the selected profile.
- Codypendent's standalone desktop and branded editor extension pin their own
  defaults even when launched from an Anton process. Explicit editor handoff and
  configured sockets retain their existing precedence.
- Chat, inline assistance, task boards, graph inspection, readiness, and session
  navigation capture one endpoint. An endpoint change cannot retarget an
  in-flight operation. Session bookmarks record the endpoint identity.
- Existing shared-session bookmarks remain available. In local mode an old or
  foreign bookmark fails with a recovery instruction; it never creates a new
  replacement session. Explicit external attachment can reopen legacy bookmarks.
- **Son of Anton: Connect to Codypendent** selects an external connection.
  **Use Local Agent Runtime** returns to Anton. A nonempty
  `sota.daemon.socketPath` is also an explicit external selection.
- External connections use the existing authenticated, version-negotiated SDK.
  Anton never starts, restarts, configures, or injects credentials into an external
  runtime. Closing a client continues to stop observation rather than cancel work.

Linux data and configuration defaults are respectively
`~/.local/share/son-of-anton` and `~/.config/son-of-anton`; Codypendent keeps its
own corresponding directories. macOS uses each product's own Application Support
directory. A private data override also isolates configuration unless an explicit
same-product configuration override is supplied.

## Product experience

Anton provider setup stays in the IDE. The existing wizard and chat setup forms
configure Anthropic, OpenAI, or Gemini model IDs through the bundled CLI's atomic
configuration writer. Keys live in Anton's extension SecretStorage and reach
only its private child processes as environment values. Model files contain
environment variable names, and readiness remains unverified until inference
actually happens. Credential changes use the engine's idle-guarded restart;
active work is preserved and the UI explains a deferred restart.

An empty-model composer links directly to setup and refreshes model readiness
after a successful save. Draft text and attachments remain in place; saving
credentials never submits a prompt.

The repository workflow launcher reads the owning runtime's resolved catalog,
shows provenance and definition digests, and collects each declared input as
JSON. An explicit trusted Start binds to that definition. Saved launch receipts
scope monitoring and lifecycle controls to the original endpoint and repository.
Unknown starts retain protected input payloads and their original idempotency
keys for explicit reconciliation; panel restoration never replays work. Unsent
workflow JSON stays in panel memory, surviving hiding and refreshes; closing the
panel can discard that draft.

The code graph inspector provides symbol drill-down, source navigation,
relationships, evidence, confidence, recorded revisions, freshness, and page
limits. In-panel path-prefix and symbol-name filters narrow large result sets.
A bounded 20-view Back history restores queries, selected symbols, focus, and
scroll position; the repository overview resets the query. Structural edges do
not establish complete impact or measured test coverage. Unsaved editor overlays
and semantic retrieval still need parity work before the compatibility graph can
be retired.

A successful, attributable Plan response can prepare an editable Act draft with
**Implement This Plan**. Existing text, attachments, model, and context selection
are retained. The action never submits, queues, or replays a run. Unknown legacy
completion/mode metadata does not establish eligibility.

Run completion preserves the configured routing profile for native and ACP
retries. Response chunks keep the model actually reported by the provider, or an
unknown identity; that response identity cannot become an invalid retry target.

## Next convergence work

1. Express Anton specialist definitions and review behaviour through the durable
   workflow engine, retaining bounded concurrency, isolated worktrees, cancellation,
   budgets, approval policy, and validation evidence. Do not run a second executor
   for the same request.
2. Compare both graph implementations on common language, rename/delete, dirty
   buffer, dependency, and retrieval fixtures. Preserve editor overlays and witness
   paths, and distinguish structural inference from compiler-resolved evidence.
3. Add user-facing task-bundle export/import using the existing verified interchange
   contract. Imported context receives fresh local identities and carries provenance;
   credentials and approval authority are never transferred.
4. Establish shared-engine Windows transport/process support before removing Anton's
   Windows compatibility runtime. The current Rust daemon is Unix-based.

Live shared sessions have one owning runtime. Separately executing products use
separate worktrees and exchange reviewed patches or commits. Database-local leases
do not coordinate independent engines; same-worktree concurrent writes require an
explicit cross-process ownership contract. Product databases must not be shared
by pointing both runtimes at the same SQLite file.

## Modification and review scope

The implementation is mainly Tier 1 product modules and tests, with Tier 2 command
registration and existing extension hooks. Runtime build/installer verification
changes are Tier 3: they are necessary to reject older same-version binaries that
ignore the product selector. Prebuilt `--binary` overrides were removed because
they cannot establish the verified source archive's isolation capability. This
packaging invariant cannot be supplied by an unrelated new module.

The existing chat webview also needs a small Tier 3 integration: its composer
owns draft state, unavailable-model gating, and keyboard focus. Wiring the setup
action and refreshed readiness there preserves drafts and makes the recovery
usable without introducing a second composer or a parallel setup flow.

No release is merged or published by these changes. Normal automated review and
platform-native installer gates still apply.
