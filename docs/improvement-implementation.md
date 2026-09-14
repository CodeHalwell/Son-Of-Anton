# Project improvement implementation

Scope: all 13 items in [the September 2026 review](project-improvement-review-2026-09-06.md). Work is on `codex/project-improvements`. The historical review remains the baseline; this file records implementation and verification.

| Item | Status | Verification / remaining work |
|---|---|---|
| 1. Actual checkpoint snapshots and recovery | Implemented and tested | Six real-Git snapshot tests plus an approval/edit/restart/restore/recovery workflow pass. Retained refs survive GC; HEAD and stash are preserved. |
| 2. Embedded graph initialization and lifecycle | Implemented and tested | Installed MCP fixture passes; one MCP-owned process, readiness notifications and bounded restarts. A workspace-switch race has a regression test; disposed processes cannot publish late logs. |
| 3. Graph freshness and obsolete-data removal | Implemented and tested | 38 Rust tests pass, two explicitly ignored; Clippy is clean. Installed fixtures exercise edit/rename/delete/restart. Totals are separate from changed-file counts. |
| 4. Workspace isolation and filesystem containment | Implemented and tested | Canonical workspace binding, shared path guards, atomic writes that preserve existing file permissions. Core snapshot, checkpoint service and shared filesystem tests pass. |
| 5. Provider tool contracts and routing | Implemented with explicit capability limits | Fourteen direct-provider variants pass two-turn tool contracts. Router HTTP fixtures cover tool histories and normalized events. The existing Bedrock adapter explicitly supports Claude only. |
| 6. Protected credential sharing | Implemented; macOS verified | Synthetic Keychain save/read/delete passed and was cleaned up. Concurrent-save/migration tests pass. A second broker cannot replace the active endpoint or token. Windows/Linux OS integration still needs native-platform verification. |
| 7. End-to-end CI and deterministic tests | Local checks pass; CI wiring updated | Core, CLI, board types, UI fixtures, installed graph, router and checkpoint suites are wired into CI. Discovery is injected and broker endpoints are isolated. The updated remote workflow has not run yet. |
| 8. Bootstrap, packaging, diagnostics, onboarding | Implemented; local bootstrap verified | Debug bootstrap with installed dependencies passed. Native assets are included by the extension packager and work outside the checkout. CLI doctor and documentation added. Fresh-install/release matrix and full Linux distribution job remain to be run in CI. |
| 9. Retrieval/task evaluation baseline | Offline baseline recorded | Versioned retrieval and approval/edit/recovery results are in `docs/evaluations`. These are deterministic regression fixtures, not evidence of live-model quality gains; a representative live-task comparison remains future evaluation work. |
| 10. Typed UI/runtime boundaries | Board and provider boundaries implemented | Board postMessage requests share a validated schema; malformed states/tools/messages are rejected. Provider serialization and service event contracts are shared. Large-module extraction remains incremental. |
| 11. Long-task rendering and interaction | UI redesign implemented and tested | Ten browser tests cover responsive layouts, light/dark/contrast styles, filters, keyboard navigation, long streams, preserved focus/draft, host cancellation and conversation resets. |
| 12. Streaming accounting and readiness | Implemented and tested | Router usage, cache costs, deadlines, cancellation, backpressure and no-replay failure behavior have regressions. Authenticated readiness distinguishes configured providers from liveness and does not claim live connectivity. |
| 13. Optional services and fork maintenance | Implemented with documented validation limits | Compose stack is opt-in; lifecycle and setup docs are consolidated. Case-collision check passes. Patch inventory and merge rehearsal helper added; HEAD smoke passes. No current upstream ref was available for a real divergence rehearsal. |

Modification tiers: changes to Son of Anton packages are Tier 1. Build and packaging integration is Tier 3 where it modifies inherited build code: those changes are required to place the first-party runtime assets inside the distributed application and make the resulting artifact testable. No upstream editor behavior needs to change for the fixes.


## UI redesign (September 7)

The board now gives the plan a clear heading, completion summary, searchable tasks, agent and status filters, and six distinct lifecycle columns. Cards expose complete instructions, expandable details, files, dependencies, and keyboard-accessible execution actions. The assistant is collapsible; narrow boards stack vertically. Its requests receive the actual board snapshot and configured default model.

Chat has a new welcome screen, more readable message surfaces, a compact composer, visible tabs at narrow widths, provider search, and useful focus outlines. History and the roster start collapsed for new layouts. Streaming text is batched per animation frame and auto-scroll respects the reader's position. A jump button resumes following. Board cancellation reaches the host and leaves the next draft intact. Hidden controls now consistently honour the HTML hidden attribute.

Validation: extension and board TypeScript checks pass; `gulp compile-extensions` passes; the extension bundle builds. Five browser tests exercise shipped frontend assets against an offline host fixture, with no external model traffic. Screenshots use representative fixture content, not a live project execution.

Run the browser suite after building core and the extension with `npm --prefix extensions/son-of-anton run test:ui`. Install Playwright's Chromium first, or set `SOTA_UI_BROWSER` to a Chromium executable. Set `SOTA_UI_SCREENSHOTS` to save visual results. The suite uses temporary browser contexts and closes them after each test. The initial pass verified 355 extension unit tests; the further refinements below expand that to 375. The redesigned chat was inspected in an isolated editor instance, which was closed after validation. Startup banners now stay in the output log without opening the Output panel.


## Further IDE refinements (September 7)

This pass improves the everyday editing and conversation workflow without changing inherited editor code (Tier 1).

- **Inline edit review:** full-file before/after previews with persistent Apply Edit and Discard Edit status-bar actions. Applying is one undoable editor edit. Revision checks before generation, review and application protect concurrent changes; the editor's versioned operation rejects edits during application. Closing the diff discards the proposal and releases temporary commands, status items and snapshots. Cancellation and extension disposal cannot apply late output. Code whitespace is preserved and the configured default model replaces the hardcoded provider choice.
- **Conversation drafts:** text, file references and selected models are stored per conversation in webview state, retaining the 20 most recently used drafts. Sending clears only that draft. Images stay in memory across conversation switches but are excluded from persisted state; the draft indicator explains that they will not survive reload. Draft text is not truncated.
- **Conversation navigation:** history search by title or specialist, date groups, active-conversation titles, focus preservation on refresh and 50-entry pages with Show More. No-match states and narrow layouts are covered. Search operates on summaries, not full transcript bodies.
- **Model selection:** search model names and providers, hide empty groups, select with arrow keys/Enter, dismiss with Escape and restore focus. Model details are available on keyboard focus. The popup stays within the viewport and is capped at 420 pixels high.
- **Context control:** expandable automatic workspace-context preview, estimated token count and a per-conversation inclusion checkbox. Explicit attachments remain independent. The host collects context again at send time, so the preview is a snapshot. Global context settings are still respected. Late previews and errors cannot overwrite another conversation's preview.
- **Streaming lifecycle:** each request owns its cancellation handle and conversation. Navigation invalidates the previous owner; late tokens, completion, errors and context preparation cannot append to the next conversation or clear its Stop handle. Cancelled responses retain partial text and visibly settle the composer. Enter while drafting a follow-up adds a line instead of stopping the active response.
- **Ghost-text completion:** preserves indentation and line breaks, promptly cancels provider requests and debounce timers, invalidates stale document revisions and disposes listeners. `sota.completions.model` selects a dedicated model; blank uses the configured default chat model. Debounce is bounded to 0–2000 ms.

Verification: `gulp compile-extensions`, explicit extension TypeScript checking and the extension bundle pass. The full extension suite passes **375 tests**; the offline browser suite passes **10 tests**. New cases cover command lifecycles with controlled editors/providers, conversation races, context exclusion, search/pagination, draft restoration, keyboard selection and cancellation. No paid model calls are made by these checks.

An isolated native Son of Anton window exercised the actual inline-edit provider with a canned response. The real diff displayed the replacement, the persistent Apply Edit action changed `return 1` to `return 2` with indentation intact, the document advanced from version 1 to 2, and both review actions disappeared after application. The checks used temporary workspace files, not project source files. Test windows and browser processes were closed.

The UI review used the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) for focus, keyboard operation, feedback and overflow. The task's `ui/refinements` artifacts show representative browser fixtures and the real native diff fixture. This is not a measured claim of parity with a competing IDE; live-provider workflows and representative task-quality comparisons remain to be evaluated.


## Final local verification

| Check | Result |
|---|---|
| Main editor TypeScript, build scripts, extension, board | Passed; `gulp compile-extensions` passed |
| Core / CLI unit suites | 69 / 11 passed |
| Extension unit suite | 375 passed with normal developer PATH |
| Router suite | 209 passed |
| Checkpoint service / shared auth and filesystem | 8 / 8 passed |
| Rust workspace | Check, 38 tests and Clippy passed; 2 pre-existing tests ignored |
| Installed graph MCP | 2 tests passed outside checkout, including persistence after restart |
| Browser UI | 10 tests passed against shipped frontend assets |
| Bootstrap / package files | Debug bootstrap passed with existing dependencies; native assets included in extension file list |
| Other affected services | Checkpoints, indexer, background tasks and gateway type checks passed; gateway uses root TypeScript to avoid the previous declaration-memory failure |
| Compose / workflow configuration | YAML parses; Compose validates with the example environment; no containers started |
| Git hygiene | Diff whitespace check and 10,720-path case-collision check passed; HEAD-only merge rehearsal passed |

No live model requests, full Compose deployment, signed releases or cross-platform desktop builds were executed locally. The Linux packaging CI job now builds a distribution and checks its extracted runtime; its result is pending an actual CI run. Real provider compatibility, real-model task quality and performance benchmarks remain separate validation. The UI was inspected in an isolated editor and in browser fixtures; test editor/browser processes were closed. Changes remain uncommitted for review.


## ACP backend update (September 7)

Replaced the private ACP service protocol with one shared ACP v1 stdio runtime used by core/IDE and the service. Added bounded process/session reuse, queue limits, real initialization/capability negotiation, bidirectional permissions, cancellation deadlines and process-group cleanup. All nine specialists can be assigned external ACP agents; the CLI exposes all ten built-in agent modes through isolated sessions. Native review/security verdict interpretation is preserved, and malformed review output now fails the quality gate.

The service now has explicit idle session allocation, cancellable messages, bounded dispatch, streamed events, permission resolution, configuration readiness and aggregate runtime metrics. Registry reloads are atomic. Native agents now discover configured MCP tools with their full input schemas, host approval and cancellation; late approval cannot execute cancelled work. The Docker build uses Node 22 and a strict TypeScript build. Bootstrap and CI verify the shared runtime copy. See [the backend guide](acp-backend.md) for the API migration and adapter setup.

Validation for this update: core 90, CLI 17, extension 375 and ACP service 11 tests passed; core/CLI/service/extension types and extension compilation passed. The fixture suite exercises real processes and loopback HTTP without paid model requests. A real handshake with the rebuilt `sota acp` CLI passed without a model prompt. Installed Gemini CLI 0.46.0 lists ACP support, but a bounded live handshake did not complete; no successful live provider interoperability is claimed. Codex and Claude adapters still need installation/authentication on this machine. External ACP usage remains explicitly unmetered by native spend caps. Durable session loading, client filesystem/terminal proxies and cross-platform native validation remain outside this implementation.

## Live conversation follow-up (September 7)

Two actual Claude Code conversations in the native app exposed raw Markdown tables, visible streaming protocol fragments, a stale thinking indicator, inconsistent usage displays and a duplicate trust-dialog action. The fixes add semantic scrollable tables, render partial Markdown while preserving source text and tool cards, clear thinking on response text, align cost reporting and update temporary trust status. ACP turns explicitly mark usage unavailable when the transport does not report it.

The extension and browser suites now pass 376 and 12 tests. A real authenticated ACP prompt also completed through the built-in Anton Docs CLI route over the existing Claude Code subscription; runtime shutdown left zero processes. The Mac locked before the final native visual pass, which remains pending. See [the live check report](evaluations/live-chat-2026-09-07.md) for the distinction between real conversations, browser fixtures and outstanding verification.
