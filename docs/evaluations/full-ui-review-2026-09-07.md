# UI and integration review — September 7, 2026

Status: the Son of Anton feature-surface review and repairs below are complete. This is not a claim of exhaustive coverage of every inherited VS Code command or every external provider. The native checks use `/tmp/sota-live-ui-1jup5csv/workspace`, which the user explicitly authorized for temporary agent trust. No real project credentials are entered by the automated browser fixtures.

## Coverage

| Surface | Native review | Automated coverage |
| --- | --- | --- |
| Chat tab and sidebar | Real authenticated Anton Docs ACP response; heading, table, code, link, streaming, completion, unavailable usage, conversation restoration | Streaming, cancellation, drafts, model picker, context, menus, code actions, tables, narrow panes, light and high contrast |
| Tasks tab | Empty state and Open Full Board | Board lifecycle and actions across all six task states |
| History tab | Both saved live conversations; search and clearing | Date groups, filtering, bounded rendering, navigation, active title |
| Settings tab | API, Models, Specialist Models, Features, Personality, MCP Servers, Integrations, Terminal, About | All nine sections, keyboard navigation, every setting input, all fourteen provider forms, MCP edit/delete dispatch |
| Roster tab | All ten visible specialist cards | Every Talk button and every specialist model dropdown |
| Full task board | Empty state, Refresh, Open Chat, Ask Anton, Hide Assistant | Populated states, filters, keyboard actions, assistant streaming and cancellation |
| Board activity sidebar | Active conversation and Open Chat | Populated full-board protocol and actions; populated native sidebar not separately exhaustive |
| Agent Status and Task Queue | Live completed ACP task visible | Existing provider tests |
| Setup wizard | Picker, visible/focused Anthropic form, required-field error | All five provider forms, links, save results, cancel, back, skip |
| Trace viewer | Empty state, Refresh, Export JSON (clipboard confirmation) | Every filter, populated timeline, keyboard details, task filter, narrow layout |
| Fleet dashboard | Loaded metrics/tasks; final service-unavailable state checked | Active/completed tasks, cancel/results/refresh; refreshed focus preservation |
| Impact analysis | Real embedded graph request from clamp.ts; file-level result displayed | Four node filters, long paths, keyboard navigation; Docker/embedded result normalization |
| Explorer / Search / Source Control | File open, symbol outline, refresh; search and regex/details; initialized Git only in disposable folder | Inherited workbench controls were sampled, not exhaustively certified |
| Debug / Extensions / Terminal | Debug-disabled and empty-extension states; extension refresh; opened a zsh terminal in the disposable workspace and closed it | No debugger launch or marketplace installation was performed |

## Repairs made

- Removed CSP-blocked inline handlers from code and terminal buttons and added delegated handlers.
- Enabled the trace viewer script with a nonce and made trace rows keyboard-operable.
- Fixed setup forms hidden by CSS, duplicate field IDs, focus return, and duplicate pending submissions.
- Hydrated Settings through both tab and gear entry paths; expanded the model menu to the actual available models.
- Corrected Settings tab labels and keyboard behavior, narrow layouts, About version, and singular history counts.
- Moved reset/delete confirmation from unsupported browser dialogs to native host dialogs; cancellation cannot change settings.
- Preserved the assistant specialist on newly saved messages.
- Made Markdown table alignment work under the actual CSP.
- Fixed impact row keyboard behavior and long-path overflow; registered the advertised Impact Analysis command.
- Made fleet tables scroll independently and periodic refresh preserve focus/scroll instead of replacing the webview.

## Additional integration and backend repairs

- Added Settings → Integrations and a shared core/CLI catalog. The real project scan found 995 entries, including 399 available skills, 89 plugins, and 34 usable MCP descriptors; the native disposable-workspace catalog displayed 994 entries. Discovery does not establish authenticated connectivity.
- Added on-demand skill metadata/resource tools, disabled-source handling, bounded reads, stable IDs, symlink containment, private host-only launch descriptors, and HTTP/SSE MCP transport support.
- Fixed HTTP initialization ordering, asynchronous send failures, shutdown during connection setup, and approval fingerprints for remote URLs/headers.
- Corrected embedded Impact Analysis request/result contracts. File-level dependency results no longer pretend to provide symbol callers or test coverage.
- Fixed restored composer selection and per-message author labels, preserving unavailable usage for new ACP responses.
- Fixed roster Start Thread to select its specialist. ACP model rows identify the owning adapter and disable ineffective local model overrides. The composer also shows Managed by ACP and hides local reasoning controls for these routes; native agents retain their model picker.
- Corrected configuration-only provider/harness labels that had claimed authentication. A configured API key and an authenticated CLI route remain separate sources of availability.
- Fixed background-service authentication using `BACKGROUND_TASK_API_TOKEN`, surfaced service failures in Fleet instead of presenting an apparently healthy empty list, and included completed tasks in polling. Cancellation failures now surface visibly.
- Removed four unimplemented command-palette placeholders: Start Spec Pipeline, List Spec Features, Run Security Scan, and Generate Spec. This does not claim those standalone workflows were implemented; specialist chat remains available.

## Validation and practical limits

- Core: **99 passing** tests.
- CLI: **17 passing** tests.
- Extension: **383 passing** tests.
- ACP service: **11 passing** tests.
- Model router: **209 passing** tests.
- Browser UI: **24 passing** scenarios under the shipped CSP, including sidebar sizes, all settings sections, all fourteen provider forms, each roster Talk button, the board, setup, trace, fleet, impact, and integrations.
- Packaged code graph: **2 passing** end-to-end scenarios covering structural/semantic behavior, native-runtime failures, file updates, renames/deletes, restart, and workspace isolation. Semantic testing uses a deterministic local embedding fixture; native app semantic search accurately remains disabled without a configured embedder.
- Background service: **1 passing** real HTTP scenario for health, authenticated task listing, unauthorized rejection, and disallowed-image rejection before Docker execution. Container execution was not tested.

Core, CLI, extension TypeScript, extension gulp compilation, service compilation, and extension bundling passed. ACP generated-runtime synchronization and diff whitespace checks passed. One browser run completed its assertions but hung during teardown; the owned runner was stopped and subsequent complete runs exited normally.

Native authenticated chat confirms transport/rendering for the configured local Anton Docs ACP route. Provider forms use offline validation fixtures; fourteen paid/authenticated provider calls were not performed. Installed Gemini ACP initialization previously timed out; third-party Codex/Claude adapters were not installed for testing. Cross-platform native behavior and Docker task execution remain unverified. The review sampled inherited Explorer, Search, Source Control, terminal, debug, and extension surfaces; it does not certify every button in the underlying VS Code workbench.

The catalog reports three pre-existing skill files with invalid YAML metadata. Application-specific plugin hooks/UI and source-app OAuth sessions are not automatically portable. See [system integrations](../system-integrations.md) for supported formats and limitations.

## Codypendent reference

Read-only review of `/Users/danielhalwell/PersonalProjects/codypendent` identified reusable designs: bounded ACP registry discovery with pinned versions; shared event fan-out for boards; distinct loading/empty/unavailable states; skills/plugin metadata with explicit source, scope, and availability. Its desktop plugin renderer is explicitly incomplete, so it should not be copied as a complete working feature. No source was copied verbatim. See [the Council and reuse assessment](codypendent-reuse-2026-09-07.md) for prioritized designs and an explicit distinction between implemented integration work and the proposed Council runner. Its MIT license is attributed to Daniel Halwell, 2026.

A final live retry exposed Claude CLI context inflation (~211,000 tokens from inherited customization/tool context). The subscription transport now disables its inherited MCP/skill catalog and uses customization-safe mode while retaining OAuth. A real minimal retry returned `TRANSPORT_OK` in 2.1 seconds with 260 input tokens. A new regression covers the isolation flags; this brings the core suite to 99 passing tests. See the [Claude CLI reference](https://code.claude.com/docs/en/cli-usage) for the transport flags.

The disposable Git repository has no initial commit, so checkpoint capture reports that HEAD is unavailable. No initial commit was created to hide this limitation; the real chat remains usable.

The final native ACP response completed with a heading, a two-row table, and a TypeScript guard, with correct Anton Docs attribution and unavailable usage. The final Fleet refresh showed a visible service-unavailable alert. Settings → Integrations displayed the source catalog with bounded descriptions and collapsed warnings; Specialist Models showed the disabled `local-anton-docs` adapter row.

After the final rebuild, native reload preserved the response and selected specialist, with Managed by ACP visible in the composer. The session counter resets on application reload; message-level unavailable usage remains preserved. The owned test app was quit and its debugging listener and ACP child processes were confirmed closed.
